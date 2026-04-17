import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type {
    WSRequest_Search,
    WSResponse_Search,
    MatchCandidate,
    IntentionKey,
    PreferredPeriod,
    SocialVibe
} from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import {
    mapUserToCandidate,
    candidateInclude,
    getDistanceKm,
    geoBoundingBox,
    ageToBirthDateRange
} from '@/services/userMapper';
import { computeMatchScore } from '@/services/scoring';
import type { ScoringCandidate, ScoringContext } from '@/services/scoring';
import { getBalance } from '@/services/tokenService';
import { getBoostedUserIds } from '@/services/boostService';
import { interleaveByBoost } from '@/services/interleaveResults';
import { logger } from '@/config/logger';

const DEFAULT_MAX_DISTANCE = 50; // km
const MAX_RESULTS = 25;

/** Add slight score jitter (±10 pts) so results with similar scores get shuffled */
function addRandomness(candidates: MatchCandidate[]): MatchCandidate[] {
    return candidates
        .map((c) => ({ c, sortKey: (c.score ?? 0) + (Math.random() - 0.5) * 20 }))
        .sort((a, b) => b.sortKey - a.sortKey)
        .map((x) => x.c);
}

registerCommand<WSRequest_Search>('search', async (client: Client, payload): Promise<WSResponse_Search> => {
    const { filters } = payload;
    const db = getDatabase();

    try {
        // Get current user's full profile for scoring context
        const currentUser = await db.user.findUnique({
            where: { id: client.userId },
            include: { profile: true, tags: { include: { tag: true } } }
        });
        const myLatLng = {
            latitude: currentUser?.profile?.latitude ?? null,
            longitude: currentUser?.profile?.longitude ?? null
        };
        const myIntentions = (currentUser?.profile?.intentions ?? []) as IntentionKey[];
        const myTagLabels = new Set((currentUser?.tags ?? []).map((t) => t.tag.label));
        const myLanguages = currentUser?.profile?.spokenLanguages ?? [];
        const myPreferredPeriod = (currentUser?.preferredPeriod ?? 'any') as PreferredPeriod;
        const mySocialVibe = (currentUser?.profile?.socialVibe ?? 'balanced') as SocialVibe;

        const where: Record<string, unknown> = {
            id: { not: client.userId },
            banned: false,
            suspended: false,
            // Only show candidates with a complete profile
            birthDate: { not: null },
            photos: { some: {} },
            tags: { some: {} },
            name: { not: '' },
            profile: {
                bio: { not: '' },
                intentions: { isEmpty: false },
                spokenLanguages: { isEmpty: false },
                latitude: { not: null }
            }
        };

        // Exclude blocked + reported users
        const [blocks, reports] = await Promise.all([
            db.block.findMany({
                where: { OR: [{ blockerId: client.userId }, { blockedId: client.userId }] },
                select: { blockerId: true, blockedId: true }
            }),
            db.report.findMany({
                where: { reporterId: client.userId },
                select: { reportedId: true }
            })
        ]);
        const blockedIds = blocks.map((b) => (b.blockerId === client.userId ? b.blockedId : b.blockerId));
        const reportedIds = reports.map((r) => r.reportedId);
        const excludeIds = [...new Set([client.userId, ...blockedIds, ...reportedIds])];
        if (excludeIds.length > 0) {
            where.id = { notIn: excludeIds };
        }

        if (filters.verified) {
            where.verified = true;
        }

        if (filters.ageRange) {
            const { after, before } = ageToBirthDateRange(filters.ageRange[0], filters.ageRange[1]);
            where.birthDate = { not: null, gte: after, lt: before };
        }

        if (filters.query) {
            where.OR = [
                { name: { contains: filters.query, mode: 'insensitive' } },
                { profile: { bio: { contains: filters.query, mode: 'insensitive' } } }
            ];
        }

        if (filters.intentions && filters.intentions.length > 0) {
            where.profile = {
                ...(where.profile as Record<string, unknown>),
                intentions: { hasSome: filters.intentions }
            };
        }

        if (filters.tags && filters.tags.length > 0) {
            where.tags = {
                some: { tag: { label: { in: filters.tags } } }
            };
        }

        // Remote mode: filter by spoken languages
        if (filters.remote && filters.languages && filters.languages.length > 0) {
            where.profile = {
                ...(where.profile as Record<string, unknown>),
                spokenLanguages: { hasSome: filters.languages }
            };
        }

        const isRemote = filters.remote === true;
        const maxDistance = isRemote ? Infinity : (filters.maxDistance ?? DEFAULT_MAX_DISTANCE);

        // Pre-filter by geo bounding box when not remote
        if (!isRemote) {
            const bbox = geoBoundingBox(myLatLng.latitude, myLatLng.longitude, maxDistance);
            if (bbox) {
                where.profile = {
                    ...(where.profile as Record<string, unknown>),
                    latitude: bbox.latitude,
                    longitude: bbox.longitude
                };
            }
        }

        const users = await db.user.findMany({
            where,
            include: { ...candidateInclude, _count: { select: { receivedReports: true } } },
            take: 1000
        });
        const targetIntentions = filters.intentions ?? [];

        const scoringCtx: ScoringContext = {
            myIntentions,
            myTagLabels,
            myLanguages,
            myLatitude: myLatLng.latitude,
            myLongitude: myLatLng.longitude,
            myPreferredPeriod,
            mySocialVibe,
            maxDistance: maxDistance === Infinity ? DEFAULT_MAX_DISTANCE : maxDistance,
            isRemote
        };

        const results = users
            .map((u) => {
                const candidate = mapUserToCandidate(u, targetIntentions, myLatLng);
                const distKm = getDistanceKm(
                    myLatLng.latitude,
                    myLatLng.longitude,
                    u.profile?.latitude,
                    u.profile?.longitude
                );

                const theirIntentions = (u.profile?.intentions ?? []) as IntentionKey[];
                const theirTags = new Set((u.tags ?? []).map((t) => t.tag.label));
                const scoringCandidate: ScoringCandidate = {
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
                    socialVibe: (u.profile?.socialVibe ?? 'balanced') as SocialVibe,
                    reportCount: u._count.receivedReports
                };
                const breakdown = computeMatchScore(scoringCtx, scoringCandidate);
                candidate.score = breakdown.total;

                return { candidate, distKm };
            })
            // Filter by distance (skip if location unknown)
            .filter((r) => {
                if (isRemote) return true;
                if (r.distKm == null) return true;
                return r.distKm <= maxDistance;
            })
            .sort((a, b) => (b.candidate.score ?? 0) - (a.candidate.score ?? 0))
            .map((r) => r.candidate);

        // Apply 60/40 boost interleave
        const boostedIds = await getBoostedUserIds();
        const interleaved = interleaveByBoost(results, boostedIds);

        const totalCount = interleaved.length;

        // Add slight randomness and limit to MAX_RESULTS
        const shuffled = addRandomness(interleaved).slice(0, MAX_RESULTS);

        // Include token balance info
        const balance = await getBalance(client.userId);

        logger.debug(`[Search] ${shuffled.length}/${totalCount} results for user: ${client.userId}`);
        return { command: 'search', payload: { results: shuffled, tokensRemaining: balance.tokens, totalCount } };
    } catch (error) {
        logger.error('[Search] Search error', error);
        return { command: 'search', payload: { error: 'Internal error' } };
    }
});
