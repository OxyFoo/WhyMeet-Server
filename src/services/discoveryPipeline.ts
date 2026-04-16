import type { Client } from '@/server/Client';
import type { IntentionKey, PreferredPeriod, SearchFilters, SocialVibe } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { candidateInclude, getDistanceKm, computeAge, ageToBirthDateRange } from '@/services/userMapper';
import { computeMatchScore, MIN_SCORE_THRESHOLD } from '@/services/scoring';
import type { ScoringCandidate, ScoringContext } from '@/services/scoring';
import { logger } from '@/config/logger';

const DEFAULT_MAX_DISTANCE = 50; // km

// Prisma user type inferred from candidateInclude
type CandidateUser = Awaited<ReturnType<ReturnType<typeof getDatabase>['user']['findMany']>>[number];

export interface QualifiedCandidate {
    user: CandidateUser;
    intentions: IntentionKey[];
    score: number;
    distKm: number | null;
}

export interface PipelineContext {
    myIntentions: IntentionKey[];
    myProfileComplete: boolean;
    prefIntentions: IntentionKey[] | undefined;
    prefMaxDistance: number;
    prefRemote: boolean;
    myLatLng: { latitude: number | null; longitude: number | null };
}

/** Pre-computed data shared across multiple pipeline queries for the same user. */
export interface PipelineSetup {
    myIntentions: IntentionKey[];
    myTagLabels: Set<string>;
    myLatLng: { latitude: number | null; longitude: number | null };
    myGender: string;
    myAge: number;
    myLanguages: string[];
    myPreferredPeriod: PreferredPeriod;
    mySocialVibe: SocialVibe;
    myProfileComplete: boolean;
    prefAgeMin: number;
    prefAgeMax: number;
    prefGenders: string[];
    prefVerified: boolean;
    storedMaxDistance: number;
    storedRemote: boolean;
    storedIntentions: IntentionKey[] | undefined;
    excludeIds: string[];
}

/**
 * Build the shared context for the discovery pipeline (user, settings, exclusion list).
 * Call once, then pass the result to `runPipelineQuery` for each intention / filter set.
 */
export async function buildPipelineContext(client: Client): Promise<PipelineSetup> {
    const db = getDatabase();

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
    const mySocialVibe = (currentUser?.profile?.socialVibe ?? 'balanced') as SocialVibe;
    const myProfileComplete =
        currentUser?.birthDate != null && myGender !== '' && myIntentions.length > 0 && myLatLng.latitude != null;

    const prefAgeMin = settings?.discoveryAgeMin ?? 18;
    const prefAgeMax = settings?.discoveryAgeMax ?? 99;
    const prefGenders = settings?.discoveryGenders ?? [];
    const prefVerified = settings?.discoveryVerified ?? false;
    const storedMaxDistance = settings?.discoveryMaxDistance ?? DEFAULT_MAX_DISTANCE;
    const storedRemote = settings?.discoveryRemoteMode ?? false;
    const storedIntentions = settings?.discoveryIntentions as IntentionKey[] | undefined;

    // Exclusion list: self, seen, blocked, reported
    const [seenMatches, blocks, reports] = await Promise.all([
        db.match.findMany({ where: { senderId: client.userId }, select: { receiverId: true } }),
        db.block.findMany({
            where: { OR: [{ blockerId: client.userId }, { blockedId: client.userId }] },
            select: { blockerId: true, blockedId: true }
        }),
        db.report.findMany({ where: { reporterId: client.userId }, select: { reportedId: true } })
    ]);

    const seenIds = seenMatches.map((m) => m.receiverId);
    const blockedIds = blocks.map((b) => (b.blockerId === client.userId ? b.blockedId : b.blockerId));
    const reportedIds = reports.map((r) => r.reportedId);
    const excludeIds = [...new Set([client.userId, ...seenIds, ...blockedIds, ...reportedIds])];

    logger.debug(
        `[Pipeline] Context for ${client.userId}: ${myIntentions.length} intentions, ${excludeIds.length} excluded, profileComplete=${myProfileComplete}`
    );

    return {
        myIntentions,
        myTagLabels,
        myLatLng,
        myGender,
        myAge,
        myLanguages,
        myPreferredPeriod,
        mySocialVibe,
        myProfileComplete,
        prefAgeMin,
        prefAgeMax,
        prefGenders,
        prefVerified,
        storedMaxDistance,
        storedRemote,
        storedIntentions,
        excludeIds
    };
}

/**
 * Build the Prisma WHERE clause for the discovery pipeline.
 * Extracted so it can be reused for both full queries and COUNT-only queries.
 */
function buildPipelineWhere(
    setup: PipelineSetup,
    filters?: SearchFilters,
    prefIntentions?: IntentionKey[],
    prefRemote?: boolean
): Record<string, unknown> {
    const where: Record<string, unknown> = {
        id: { notIn: setup.excludeIds },
        banned: false,
        suspended: false,
        deleted: false,
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

    if (setup.prefAgeMin > 18 || setup.prefAgeMax < 99) {
        const { after, before } = ageToBirthDateRange(setup.prefAgeMin, setup.prefAgeMax);
        where.birthDate = { not: null, gte: after, lt: before };
    }

    if (setup.prefGenders.length > 0) {
        where.gender = { in: setup.prefGenders };
    }

    if (setup.prefVerified) {
        where.verified = true;
    }

    if (prefIntentions && prefIntentions.length > 0) {
        profileWhere.intentions = { hasSome: prefIntentions };
    } else if (setup.myIntentions.length > 0) {
        profileWhere.intentions = { hasSome: setup.myIntentions };
    }

    if (prefRemote && filters?.languages && filters.languages.length > 0) {
        profileWhere.spokenLanguages = { hasSome: filters.languages };
    }

    if (Object.keys(profileWhere).length > 0) {
        where.profile = profileWhere;
    }

    // ── Visibility pre-filter (candidate's settings must accept me) ──
    if (setup.myProfileComplete) {
        const visibilityFilter: Record<string, unknown>[] = [];
        visibilityFilter.push({ visibilityAgeMin: { lte: setup.myAge } });
        visibilityFilter.push({ visibilityAgeMax: { gte: setup.myAge } });

        if (setup.myGender !== '') {
            visibilityFilter.push({ visibilityGenders: { hasSome: [setup.myGender] } });
        }

        if (setup.myIntentions.length > 0) {
            visibilityFilter.push({
                OR: [
                    { visibilityIntentions: { isEmpty: true } },
                    { visibilityIntentions: { hasSome: setup.myIntentions } }
                ]
            });
        }

        where.settings = { AND: visibilityFilter };
    }

    // ── Tags filter (user must have at least one matching tag) ───
    if (filters?.tags && filters.tags.length > 0) {
        where.tags = {
            some: {
                tag: { label: { in: filters.tags } }
            }
        };
    }

    // ── Free-text query filter (name or bio contains text) ───────
    if (filters?.query && filters.query.trim() !== '') {
        const q = filters.query.trim();
        where.OR = [
            { name: { contains: q, mode: 'insensitive' } },
            {
                profile: {
                    ...profileWhere,
                    bio: { contains: q, mode: 'insensitive' }
                }
            }
        ];
        delete where.profile;
    }

    return where;
}

/**
 * COUNT-only variant: returns the number of users matching the pipeline filters
 * without fetching rows or running JS scoring. ~20-50× cheaper than runPipelineQuery.
 * Counts may be slightly higher than qualified.length (no JS distance/score filtering)
 * but are accurate enough for badge/indicator purposes.
 */
export async function countPipelineQuery(setup: PipelineSetup, filters?: SearchFilters): Promise<number> {
    const db = getDatabase();
    const prefIntentions = filters?.intentions ?? (setup.storedIntentions?.length ? setup.storedIntentions : undefined);
    const prefRemote = filters?.remote ?? setup.storedRemote;
    const where = buildPipelineWhere(setup, filters, prefIntentions, prefRemote);
    return db.user.count({ where });
}

/**
 * Run the SQL query + scoring pipeline using a pre-built context.
 * `filters` override stored preferences (intentions, distance, remote, languages).
 */
export async function runPipelineQuery(
    setup: PipelineSetup,
    filters?: SearchFilters,
    fetchLimit: number = 100
): Promise<{ qualified: QualifiedCandidate[]; ctx: PipelineContext }> {
    const db = getDatabase();

    const prefMaxDistance = filters?.maxDistance ?? setup.storedMaxDistance;
    const prefRemote = filters?.remote ?? setup.storedRemote;
    const prefIntentions = filters?.intentions ?? (setup.storedIntentions?.length ? setup.storedIntentions : undefined);

    const where = buildPipelineWhere(setup, filters, prefIntentions, prefRemote);

    // ── Fetch candidates (deterministic order for consistent results) ─
    const users = await db.user.findMany({
        where,
        include: { ...candidateInclude, _count: { select: { receivedReports: true } } },
        orderBy: { createdAt: 'desc' },
        take: fetchLimit
    });

    // ── Score & post-filter ──────────────────────────────────────
    const scoringCtx: ScoringContext = {
        myIntentions: setup.myIntentions,
        myTagLabels: setup.myTagLabels,
        myLanguages: setup.myLanguages,
        myLatitude: setup.myLatLng.latitude,
        myLongitude: setup.myLatLng.longitude,
        myPreferredPeriod: setup.myPreferredPeriod,
        mySocialVibe: setup.mySocialVibe,
        maxDistance: prefMaxDistance,
        isRemote: prefRemote
    };

    const qualified = users
        .map((u) => {
            const theirIntentions = (u.profile?.intentions ?? []) as IntentionKey[];
            const theirTags = new Set<string>((u.tags ?? []).map((t) => t.tag.label));
            const distKm = getDistanceKm(
                setup.myLatLng.latitude,
                setup.myLatLng.longitude,
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
                socialVibe: (u.profile?.socialVibe ?? 'balanced') as SocialVibe,
                reportCount: u._count.receivedReports
            };

            const breakdown = computeMatchScore(scoringCtx, candidate);

            return {
                user: u as CandidateUser,
                intentions: theirIntentions,
                score: breakdown.total,
                distKm
            } satisfies QualifiedCandidate;
        })
        .filter((s) => {
            if (prefRemote) return true;
            if (s.distKm == null) return true;
            return s.distKm <= prefMaxDistance;
        })
        .filter((s) => {
            if (prefRemote) return true;
            const candidateMaxDist = (s.user as { settings?: { visibilityMaxDistance?: number } }).settings
                ?.visibilityMaxDistance;
            if (candidateMaxDist == null) return true;
            if (s.distKm == null) return true;
            return s.distKm <= candidateMaxDist;
        })
        .filter((s) => s.score >= MIN_SCORE_THRESHOLD);

    qualified.sort((a, b) => b.score - a.score);

    const intentionLabel = prefIntentions?.join(',') ?? 'all';
    logger.debug(
        `[Pipeline] Query(${intentionLabel}): ${users.length} fetched → ${qualified.length} qualified (limit=${fetchLimit})`
    );

    return {
        qualified,
        ctx: {
            myIntentions: setup.myIntentions,
            myProfileComplete: setup.myProfileComplete,
            prefIntentions,
            prefMaxDistance,
            prefRemote,
            myLatLng: setup.myLatLng
        }
    };
}

/** Convenience wrapper: builds context + runs query in one call. */
export async function runDiscoveryPipeline(
    client: Client,
    filters?: SearchFilters,
    fetchLimit: number = 100
): Promise<{ qualified: QualifiedCandidate[]; ctx: PipelineContext }> {
    const setup = await buildPipelineContext(client);
    return runPipelineQuery(setup, filters, fetchLimit);
}
