import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type {
    WSRequest_PreviewSearch,
    WSResponse_PreviewSearch,
    IntentionKey,
    PreferredPeriod,
    SocialVibe
} from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { mapUserToCandidate, candidateInclude, getDistanceKm, ageToBirthDateRange } from '@/services/userMapper';
import { computeMatchScore } from '@/services/scoring';
import type { ScoringCandidate, ScoringContext } from '@/services/scoring';
import { logger } from '@/config/logger';

const DEFAULT_MAX_DISTANCE = 50;

// Random first names for preview randomization
const PREVIEW_NAMES = [
    'Alex',
    'Camille',
    'Jordan',
    'Charlie',
    'Morgan',
    'Jules',
    'Lou',
    'Eden',
    'Noa',
    'Sasha',
    'Robin',
    'Ange',
    'Claude',
    'Dominique',
    'Sam',
    'Taylor',
    'Casey',
    'Riley',
    'Quinn',
    'Avery'
];

const PREVIEW_BIOS = [
    "Esprit curieux en quête d'aventure 🌍",
    'Café addict & bookworm 📚',
    'Toujours partant pour découvrir de nouvelles choses ✨',
    'La vie est trop courte pour ne pas sourire 😊',
    'Passionné par les rencontres authentiques 🤝'
];

registerCommand<WSRequest_PreviewSearch>(
    'preview-search',
    async (client: Client, payload): Promise<WSResponse_PreviewSearch> => {
        const { filters } = payload;
        const db = getDatabase();

        try {
            // Run the real search query internally
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
            if (excludeIds.length > 0) where.id = { notIn: excludeIds };

            if (filters.verified) where.verified = true;
            if (filters.ageRange) {
                const { after, before } = ageToBirthDateRange(filters.ageRange[0], filters.ageRange[1]);
                where.birthDate = { not: null, gte: after, lt: before };
            }
            if (filters.intentions && filters.intentions.length > 0) {
                where.profile = {
                    ...(where.profile as Record<string, unknown>),
                    intentions: { hasSome: filters.intentions }
                };
            }
            if (filters.tags && filters.tags.length > 0) {
                where.tags = { some: { tag: { label: { in: filters.tags } } } };
            }
            if (filters.remote && filters.languages && filters.languages.length > 0) {
                where.profile = {
                    ...(where.profile as Record<string, unknown>),
                    spokenLanguages: { hasSome: filters.languages }
                };
            }

            const users = await db.user.findMany({
                where,
                include: candidateInclude,
                take: 100
            });

            const isRemote = filters.remote === true;
            const maxDistance = isRemote ? Infinity : (filters.maxDistance ?? DEFAULT_MAX_DISTANCE);
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

            // Fetch all tags from DB for randomization
            const allTags = await db.tag.findMany({ select: { label: true }, take: 50 });
            const allTagLabels = allTags.map((t) => t.label);

            const INTENTION_KEYS: IntentionKey[] = [
                'networking',
                'friendship',
                'dating',
                'activity_partner',
                'casual_chat',
                'group_activity'
            ];

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
                        socialVibe: (u.profile?.socialVibe ?? 'balanced') as SocialVibe
                    };
                    const breakdown = computeMatchScore(scoringCtx, scoringCandidate);
                    candidate.score = breakdown.total;
                    return { candidate, distKm };
                })
                .filter((r) => {
                    if (isRemote) return true;
                    if (r.distKm == null) return true;
                    return r.distKm <= maxDistance;
                })
                .sort((a, b) => (b.candidate.score ?? 0) - (a.candidate.score ?? 0))
                .map((r) => r.candidate);

            // Randomize data but keep real photos — mark as blurred
            const randomized = results.map((c) => {
                const randomName = PREVIEW_NAMES[Math.floor(Math.random() * PREVIEW_NAMES.length)];
                const randomBio = PREVIEW_BIOS[Math.floor(Math.random() * PREVIEW_BIOS.length)];
                const randomAge = (c.user.age ?? 25) + Math.floor(Math.random() * 11) - 5;
                const randomDistance = `${Math.floor(Math.random() * 50) + 1} km`;
                const randomIntentionCount = Math.floor(Math.random() * 3) + 1;
                const randomIntentions = shuffleArray(INTENTION_KEYS).slice(0, randomIntentionCount);
                const randomInterests =
                    allTagLabels.length > 0
                        ? shuffleArray(allTagLabels).slice(0, Math.floor(Math.random() * 4) + 1)
                        : c.interests;

                return {
                    ...c,
                    user: {
                        ...c.user,
                        name: randomName,
                        age: Math.max(18, randomAge)
                    },
                    bio: randomBio,
                    intentions: randomIntentions,
                    interests: randomInterests,
                    skills: [],
                    distance: randomDistance,
                    distanceKm: Math.floor(Math.random() * 50) + 1,
                    blurred: true
                    // photos (c.user.photos) are kept real — client will blur them visually
                };
            });

            logger.debug(`[Search] ${randomized.length} preview results for user: ${client.userId}`);
            return { command: 'preview-search', payload: { results: randomized } };
        } catch (error) {
            logger.error('[Search] Preview search error', error);
            return { command: 'preview-search', payload: { error: 'Internal error' } };
        }
    }
);

function shuffleArray<T>(arr: T[]): T[] {
    const shuffled = [...arr];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}
