import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type {
    WSRequest_GetCandidateCounts,
    WSResponse_GetCandidateCounts,
    IntentionKey,
    PreferredPeriod,
    SocialVibe
} from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { candidateInclude, getDistanceKm, computeAge, ageToBirthDateRange } from '@/services/userMapper';
import { computeMatchScore, MIN_SCORE_THRESHOLD } from '@/services/scoring';
import type { ScoringCandidate, ScoringContext } from '@/services/scoring';
import { logger } from '@/config/logger';

const DEFAULT_MAX_DISTANCE = 50;

registerCommand<WSRequest_GetCandidateCounts>(
    'get-candidate-counts',
    async (client: Client): Promise<WSResponse_GetCandidateCounts> => {
        const db = getDatabase();

        try {
            const [currentUser, settings] = await Promise.all([
                db.user.findUnique({
                    where: { id: client.userId },
                    include: { profile: true, tags: { include: { tag: true } } }
                }),
                db.settings.findUnique({ where: { userId: client.userId } })
            ]);

            const myIntentions = (currentUser?.profile?.intentions ?? []) as IntentionKey[];
            const myTagLabels = new Set((currentUser?.tags ?? []).map((t) => t.tag.label));
            const myGender = currentUser?.gender ?? '';
            const myAge = computeAge(currentUser?.birthDate ?? null);
            const myLanguages = currentUser?.profile?.spokenLanguages ?? [];
            const myPreferredPeriod = (currentUser?.preferredPeriod ?? 'any') as PreferredPeriod;
            const mySocialVibe = (currentUser?.profile?.socialVibe ?? 'balanced') as SocialVibe;
            const myLatLng = {
                latitude: currentUser?.profile?.latitude ?? null,
                longitude: currentUser?.profile?.longitude ?? null
            };

            const myProfileComplete =
                currentUser?.birthDate != null &&
                myGender !== '' &&
                myIntentions.length > 0 &&
                myLatLng.latitude != null;

            const prefAgeMin = settings?.discoveryAgeMin ?? 18;
            const prefAgeMax = settings?.discoveryAgeMax ?? 99;
            const prefGenders = settings?.discoveryGenders ?? [];
            const prefIntentions = settings?.discoveryIntentions as IntentionKey[] | undefined;
            const prefVerified = settings?.discoveryVerified ?? false;
            const prefMaxDistance = settings?.discoveryMaxDistance ?? DEFAULT_MAX_DISTANCE;
            const prefRemote = settings?.discoveryRemoteMode ?? false;

            // Exclusion list
            const [seenMatches, blocks, reports] = await Promise.all([
                db.match.findMany({
                    where: { senderId: client.userId },
                    select: { receiverId: true }
                }),
                db.block.findMany({
                    where: { OR: [{ blockerId: client.userId }, { blockedId: client.userId }] },
                    select: { blockerId: true, blockedId: true }
                }),
                db.report.findMany({
                    where: { reporterId: client.userId },
                    select: { reportedId: true }
                })
            ]);

            const seenIds = seenMatches.map((m) => m.receiverId);
            const blockedIds = blocks.map((b) => (b.blockerId === client.userId ? b.blockedId : b.blockerId));
            const reportedIds = reports.map((r) => r.reportedId);
            const excludeIds = [...new Set([client.userId, ...seenIds, ...blockedIds, ...reportedIds])];

            // ── Hard filters ─────────────────────────────────────────
            const where: Record<string, unknown> = {
                id: { notIn: excludeIds },
                banned: false,
                birthDate: { not: null },
                photos: { some: {} },
                tags: { some: {} },
                name: { not: '' }
            };

            const profileWhere: Record<string, unknown> = {
                bio: { not: '' },
                intentions: { isEmpty: false },
                spokenLanguages: { isEmpty: false },
                latitude: { not: null }
            };

            if (prefAgeMin > 18 || prefAgeMax < 99) {
                const { after, before } = ageToBirthDateRange(prefAgeMin, prefAgeMax);
                where.birthDate = { not: null, gte: after, lt: before };
            }

            if (prefGenders.length > 0) {
                where.gender = { in: prefGenders };
            }

            if (prefVerified) {
                where.verified = true;
            }

            if (prefIntentions && prefIntentions.length > 0) {
                profileWhere.intentions = { hasSome: prefIntentions };
            } else if (myIntentions.length > 0) {
                profileWhere.intentions = { hasSome: myIntentions };
            }

            if (Object.keys(profileWhere).length > 0) {
                where.profile = profileWhere;
            }

            // ── Visibility pre-filter ────────────────────────────────
            if (myProfileComplete) {
                const visibilityFilter: Record<string, unknown>[] = [];
                visibilityFilter.push({ visibilityAgeMin: { lte: myAge } });
                visibilityFilter.push({ visibilityAgeMax: { gte: myAge } });

                if (myGender !== '') {
                    visibilityFilter.push({ visibilityGenders: { hasSome: [myGender] } });
                }

                if (myIntentions.length > 0) {
                    visibilityFilter.push({
                        OR: [
                            { visibilityIntentions: { isEmpty: true } },
                            { visibilityIntentions: { hasSome: myIntentions } }
                        ]
                    });
                }

                where.settings = { AND: visibilityFilter };
            }

            // ── Fetch and score (same pipeline as get-candidates) ────
            const users = await db.user.findMany({
                where,
                include: {
                    ...candidateInclude
                },
                take: 200
            });

            const scoringCtx: ScoringContext = {
                myIntentions,
                myTagLabels,
                myLanguages,
                myLatitude: myLatLng.latitude,
                myLongitude: myLatLng.longitude,
                myPreferredPeriod,
                mySocialVibe,
                maxDistance: prefMaxDistance,
                isRemote: prefRemote
            };

            const qualified = users
                .map((u) => {
                    const theirIntentions = (u.profile?.intentions ?? []) as IntentionKey[];
                    const theirTags = new Set((u.tags ?? []).map((t) => t.tag.label));
                    const distKm = getDistanceKm(
                        myLatLng.latitude,
                        myLatLng.longitude,
                        u.profile?.latitude,
                        u.profile?.longitude
                    );

                    const candidate: ScoringCandidate = {
                        intentions: theirIntentions,
                        tagLabels: theirTags,
                        spokenLanguages: u.profile?.spokenLanguages ?? [],
                        latitude: u.profile?.latitude ?? null,
                        longitude: u.profile?.longitude ?? null,
                        bio: u.profile?.bio ?? '',
                        photoCount: (u.photos ?? []).length,
                        verified: u.verified,
                        tagCount: (u.tags ?? []).length,
                        preferredPeriod: (u.preferredPeriod ?? 'any') as PreferredPeriod,
                        socialVibe: (u.profile?.socialVibe ?? 'balanced') as SocialVibe
                    };

                    const breakdown = computeMatchScore(scoringCtx, candidate);

                    return {
                        intentions: theirIntentions,
                        score: breakdown.total,
                        distKm,
                        visibilityMaxDistance: (u as { settings?: { visibilityMaxDistance?: number } }).settings
                            ?.visibilityMaxDistance
                    };
                })
                // Post-filter: distance
                .filter((s) => {
                    if (prefRemote) return true;
                    if (s.distKm == null) return true;
                    return s.distKm <= prefMaxDistance;
                })
                // Post-filter: candidate visibility distance
                .filter((s) => {
                    if (prefRemote) return true;
                    if (s.visibilityMaxDistance == null) return true;
                    if (s.distKm == null) return true;
                    return s.distKm <= s.visibilityMaxDistance;
                })
                // Score threshold
                .filter((s) => s.score >= MIN_SCORE_THRESHOLD);

            // ── Count per intention ──────────────────────────────────
            const counts: Record<string, number> = {};
            for (const u of qualified) {
                for (const i of u.intentions) {
                    counts[i] = (counts[i] || 0) + 1;
                }
            }

            logger.debug(`[Discovery] Candidate counts for user: ${client.userId}`);
            return { command: 'get-candidate-counts', payload: { counts } };
        } catch (error) {
            logger.error('[Discovery] Get candidate counts error', error);
            return { command: 'get-candidate-counts', payload: { error: 'Internal error' } };
        }
    }
);
