import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetCandidates, WSResponse_GetCandidates, IntentionKey, PreferredPeriod } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import {
    mapUserToCandidate,
    candidateInclude,
    getDistanceKm,
    computeAge,
    ageToBirthDateRange
} from '@/services/userMapper';
import { computeMatchScore, MIN_SCORE_THRESHOLD } from '@/services/scoring';
import type { ScoringCandidate, ScoringContext } from '@/services/scoring';
import { logger } from '@/config/logger';

const DEFAULT_MAX_DISTANCE = 50; // km

registerCommand<WSRequest_GetCandidates>(
    'get-candidates',
    async (client: Client, payload): Promise<WSResponse_GetCandidates> => {
        const db = getDatabase();
        const filters = payload.filters;

        try {
            // Get current user's profile and preferences in parallel
            const [currentUser, settings] = await Promise.all([
                db.user.findUnique({
                    where: { id: client.userId },
                    include: { profile: true, tags: { include: { tag: true } } }
                }),
                db.settings.findUnique({ where: { userId: client.userId } })
            ]);

            const myIntentions = (currentUser?.profile?.intentions ?? []) as IntentionKey[];
            const myTagLabels = new Set((currentUser?.tags ?? []).map((t) => t.tag.label));
            const myLatLng = {
                latitude: currentUser?.profile?.latitude ?? null,
                longitude: currentUser?.profile?.longitude ?? null
            };
            const myGender = currentUser?.gender ?? '';
            const myAge = computeAge(currentUser?.birthDate ?? null);
            const myLanguages = currentUser?.profile?.spokenLanguages ?? [];
            const myPreferredPeriod = (currentUser?.preferredPeriod ?? 'any') as PreferredPeriod;

            // Use stored preferences, fall back to payload filters, then defaults
            const prefAgeMin = settings?.discoveryAgeMin ?? 18;
            const prefAgeMax = settings?.discoveryAgeMax ?? 99;
            const prefGenders = settings?.discoveryGenders ?? [];
            const prefMaxDistance = filters?.maxDistance ?? settings?.discoveryMaxDistance ?? DEFAULT_MAX_DISTANCE;
            const prefRemote = filters?.remote ?? settings?.discoveryRemoteMode ?? false;
            const prefIntentions = filters?.intentions ?? (settings?.discoveryIntentions as IntentionKey[] | undefined);
            const prefVerified = settings?.discoveryVerified ?? false;
            const prefPhotosOnly = settings?.discoveryPhotosOnly ?? false;

            // Get IDs to exclude: self, seen, blocked, reported
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

            // ── Hard filters (SQL pre-filter) ───────────────────────────

            const where: Record<string, unknown> = {
                id: { notIn: excludeIds },
                banned: false,
                // Only show candidates with a complete profile
                birthDate: { not: null },
                photos: { some: {} },
                tags: { some: {} },
                name: { not: '' }
            };

            // Profile completeness: bio, intentions, languages, location must be filled
            const profileWhere: Record<string, unknown> = {
                bio: { not: '' },
                intentions: { isEmpty: false },
                spokenLanguages: { isEmpty: false },
                latitude: { not: null }
            };

            // Age range filter (via birthDate — merge with existing not-null constraint)
            if (prefAgeMin > 18 || prefAgeMax < 99) {
                const { after, before } = ageToBirthDateRange(prefAgeMin, prefAgeMax);
                where.birthDate = { not: null, gte: after, lt: before };
            }

            // Gender filter
            if (prefGenders.length > 0) {
                where.gender = { in: prefGenders };
            }

            // Verified filter
            if (prefVerified) {
                where.verified = true;
            }

            if (prefIntentions && prefIntentions.length > 0) {
                profileWhere.intentions = { hasSome: prefIntentions };
            } else if (myIntentions.length > 0) {
                profileWhere.intentions = { hasSome: myIntentions };
            }

            // Remote mode: filter by spoken languages
            if (prefRemote && filters?.languages && filters.languages.length > 0) {
                profileWhere.spokenLanguages = { hasSome: filters.languages };
            }

            if (Object.keys(profileWhere).length > 0) {
                where.profile = profileWhere;
            }

            // ── Visibility pre-filter (candidate's settings must accept me) ──
            const visibilityFilter: Record<string, unknown>[] = [];

            // Candidate must accept my age
            visibilityFilter.push({ visibilityAgeMin: { lte: myAge } });
            visibilityFilter.push({ visibilityAgeMax: { gte: myAge } });

            // Candidate must accept my gender (if I have one set)
            if (myGender !== '') {
                visibilityFilter.push({ visibilityGenders: { hasSome: [myGender] } });
            }

            // Candidate must accept at least one of my intentions (or have no restriction)
            if (myIntentions.length > 0) {
                visibilityFilter.push({
                    OR: [
                        { visibilityIntentions: { isEmpty: true } },
                        { visibilityIntentions: { hasSome: myIntentions } }
                    ]
                });
            }

            where.settings = { AND: visibilityFilter };

            // ── Fetch candidates ─────────────────────────────────────
            const users = await db.user.findMany({
                where,
                include: {
                    ...candidateInclude
                },
                take: 100
            });

            // ── Score and rank ──────────────────────────────────────────
            const scoringCtx: ScoringContext = {
                myIntentions,
                myTagLabels,
                myLanguages,
                myLatitude: myLatLng.latitude,
                myLongitude: myLatLng.longitude,
                myPreferredPeriod,
                maxDistance: prefMaxDistance,
                isRemote: prefRemote
            };

            const scored = users
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
                        preferredPeriod: (u.preferredPeriod ?? 'any') as PreferredPeriod
                    };

                    const breakdown = computeMatchScore(scoringCtx, candidate);

                    return { user: u, score: breakdown.total, distKm };
                })
                // Post-filter: distance (Prisma can't do geo math)
                .filter((s) => {
                    if (prefRemote) return true;
                    if (s.distKm == null) return true;
                    return s.distKm <= prefMaxDistance;
                })
                // Post-filter: visibility distance (candidate's max distance towards me)
                .filter((s) => {
                    if (prefRemote) return true;
                    const candidateMaxDist = (s.user as { settings?: { visibilityMaxDistance?: number } }).settings
                        ?.visibilityMaxDistance;
                    if (candidateMaxDist == null) return true;
                    if (s.distKm == null) return true;
                    return s.distKm <= candidateMaxDist;
                })
                // Score threshold
                .filter((s) => s.score >= MIN_SCORE_THRESHOLD);

            scored.sort((a, b) => b.score - a.score);

            const candidates = scored.slice(0, 20).map((s) => mapUserToCandidate(s.user, prefIntentions, myLatLng));

            logger.debug(`[Discovery] ${candidates.length} candidates for user: ${client.userId}`);
            return { command: 'get-candidates', payload: { candidates } };
        } catch (error) {
            logger.error('[Discovery] Get candidates error', error);
            return { command: 'get-candidates', payload: { error: 'Internal error' } };
        }
    }
);
