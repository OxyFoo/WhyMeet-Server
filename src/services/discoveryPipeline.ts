import type { Client } from '@/server/Client';
import type {
    InterestCategoryKey,
    PreferredPeriod,
    SearchFilters,
    IntentionMatchSummary,
    IntentionKey,
    IntentionCategoryKey,
    SocialVibe
} from '@oxyfoo/whymeet-types';
import {
    getAllIntentionsForCategory,
    getCategoryKeyForIntention,
    getParentKeyForIntention,
    isIntentionKey,
    SOCIAL_VIBES
} from '@oxyfoo/whymeet-types';
import type { Prisma } from '@prisma/client';
import { getDatabase } from '@/services/database';
import {
    candidateInclude,
    getDistanceKm,
    computeAge,
    ageToBirthDateRange,
    geoBoundingBox
} from '@/services/userMapper';
import { buildIntentionMatchSummary, computeMatchScore, MIN_SCORE_THRESHOLD } from '@/services/scoring';
import type { ScoringCandidate, ScoringContext } from '@/services/scoring';
import { isProfileComplete } from '@/services/profileCompletion';
import { getExcludeIds } from '@/services/excludeCache';
import { getCandidates, setCandidates } from '@/services/candidateCache';
import { getPipelineSetup, setPipelineSetup } from '@/services/pipelineSetupCache';
import { isFeatureEnabled } from '@/services/featureFlagService';
import { resolveDomain } from '@/services/tagDomain';
import { logger } from '@/config/logger';
import { normalizeActiveIntentionCategoryKeys, normalizeActiveIntentionKeys } from '@/services/intentionKeys';

const DEFAULT_MAX_DISTANCE = 50; // km
const MIN_EXACT_INTENTION_RESULTS = 6;

/**
 * Shared fetch limit for the whole discovery pipeline (swipe, counts, search).
 * This is the maximum number of candidates we load from the DB before JS scoring.
 * Over this threshold, counts are capped (the UI shows "999+").
 * Keep it aligned across `get-candidates`, `get-candidate-counts`,
 * `search-with-token` and `preview-search` so every screen reports the same number.
 */
export const DISCOVERY_FETCH_LIMIT = 999;

// Full include used for candidate DB queries
const candidateQueryInclude = {
    ...candidateInclude,
    _count: { select: { receivedReports: true } }
} as const;

type CandidateUser = Prisma.UserGetPayload<{ include: typeof candidateQueryInclude }>;

export interface QualifiedCandidate {
    user: CandidateUser;
    intentionKeys: IntentionKey[];
    intentionMatch?: IntentionMatchSummary;
    score: number;
    distKm: number | null;
}

export function countQualifiedByIntentionCategory(
    qualified: readonly QualifiedCandidate[],
    categories: readonly IntentionCategoryKey[]
): Record<string, number> {
    const counts = Object.fromEntries(categories.map((key) => [key, 0])) as Record<string, number>;
    const accepted = new Set<IntentionCategoryKey>(categories);

    for (const candidate of qualified) {
        const candidateCategories = new Set(candidate.intentionKeys.map((key) => getCategoryKeyForIntention(key)));
        for (const categoryKey of candidateCategories) {
            if (accepted.has(categoryKey)) counts[categoryKey]++;
        }
    }

    return counts;
}

export function countQualifiedByIntention(
    qualified: readonly QualifiedCandidate[],
    intentionKeys: readonly IntentionKey[]
): Record<string, number> {
    const counts = Object.fromEntries(intentionKeys.map((key) => [key, 0])) as Record<string, number>;
    const accepted = new Map<IntentionKey, Set<IntentionKey>>(
        intentionKeys.map((key) => [key, new Set(normalizeActiveIntentionKeys([key]))])
    );

    for (const candidate of qualified) {
        const candidateKeys = new Set(normalizeActiveIntentionKeys(candidate.intentionKeys));
        for (const [requestedKey, matchingKeys] of accepted) {
            for (const k of matchingKeys) {
                if (candidateKeys.has(k)) {
                    counts[requestedKey]++;
                    break;
                }
            }
        }
    }

    return counts;
}

export interface PipelineContext {
    myIntentionKeys: IntentionKey[];
    myProfileComplete: boolean;
    prefCategoryKey: IntentionCategoryKey | undefined;
    prefIntentionKeys: IntentionKey[] | undefined;
    prefMaxDistance: number;
    prefRemote: boolean;
    myLatLng: { latitude: number | null; longitude: number | null };
}

/** Pre-computed data shared across multiple pipeline queries for the same user. */
export interface PipelineSetup {
    myIntentionKeys: IntentionKey[];
    myIntentionCategoryKeys: IntentionCategoryKey[];
    myInterestLabels: Set<string>;
    mySkillLabels: Set<string>;
    myDomainCounts: Map<InterestCategoryKey, number>;
    myLatLng: { latitude: number | null; longitude: number | null };
    myGender: string;
    myAge: number;
    myLanguages: string[];
    myPreferredPeriod: PreferredPeriod;
    mySocialVibe: SocialVibe;
    myProfileComplete: boolean;
    /**
     * Synthetic stresstest account flag. Bots only see other bots in
     * discovery; real users only see real users. Never expose this flag to
     * the client.
     */
    myIsBot: boolean;
    /**
     * When true, the bot/user isolation is broken: bots see real users and
     * real users see bots. Driven by the `stresstest.bot_user_mixing` feature
     * flag — false in production. Loaded once per setup build and cached.
     */
    mixBots: boolean;
    prefAgeMin: number;
    prefAgeMax: number;
    prefGenders: string[];
    prefVerified: boolean;
    prefLanguages: string[];
    storedMaxDistance: number;
    storedRemote: boolean;
    excludeIds: string[];
    /** IDs of users who have an unresponded pending like on me. They bypass the
     *  visibility pre-filter: if someone already liked me they clearly want to
     *  be discovered by me, regardless of their visibility settings. */
    incomingLikerIds: string[];
}

/**
 * Shape of a joined user_tag row used by `buildTagScoringData`. Loose typing
 * lets us reuse the helper with cached/deserialised shapes (candidateCache
 * returns plain objects). The canonical `tag` is optional — a user_tag may
 * not yet be linked to one (promotion happens in a batch job).
 */
type TagRow = {
    type: string;
    label?: string;
    labelLower?: string;
    tag?: { id: string; label?: string; domainKey?: string | null; embedding?: number[] | null } | null;
};

/**
 * No more ancestor/descendant expansion: profile.intentionKeys now stores
 * exactly the keys the user picked. Sibling-confusion bug (Culture vs Sport
 * via shared parent) is eliminated by symmetry. Category filters expand to
 * the whole category's intentions in `buildPipelineWhere`.
 */
function normalizeIntentionKeysForQuery(keys: readonly IntentionKey[] | undefined): IntentionKey[] | undefined {
    const activeKeys = normalizeActiveIntentionKeys(keys);
    return activeKeys.length === 0 ? undefined : activeKeys;
}

/**
 * Derive the structures needed by the scoring engine from a list of user
 * tag rows. Match between users uses the lowercased raw label (so two users
 * who typed the same word match even without a canonical link). The domain
 * affinity bonus only kicks in for canonically-linked tags. Lazy domain
 * backfill is fire-and-forget for canonical tags missing a `domainKey`.
 */
export function buildTagScoringData(tags: TagRow[] | undefined): {
    interestLabels: Set<string>;
    skillLabels: Set<string>;
    domainCounts: Map<InterestCategoryKey, number>;
} {
    const interestLabels = new Set<string>();
    const skillLabels = new Set<string>();
    const domainCounts = new Map<InterestCategoryKey, number>();

    for (const row of tags ?? []) {
        const labelLower = row.labelLower ?? row.label?.toLowerCase() ?? row.tag?.label?.toLowerCase();
        if (!labelLower) continue;
        if (row.type === 'interest') interestLabels.add(labelLower);
        else if (row.type === 'skill') skillLabels.add(labelLower);
        else continue;

        // Domain affinity is only available for canonically-linked tags.
        const canonical = row.tag;
        if (!canonical) continue;
        const domain = canonical.domainKey as InterestCategoryKey | null | undefined;
        if (domain) {
            domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
        } else if (canonical.embedding && canonical.embedding.length > 0 && canonical.id) {
            // Backfill lazily: resolve a domain for this tag, persist, forget.
            lazyResolveDomain(canonical.id, canonical.embedding).catch(() => {});
        }
    }

    return { interestLabels, skillLabels, domainCounts };
}

async function lazyResolveDomain(tagId: string, embedding: number[]): Promise<void> {
    const domain = await resolveDomain(embedding);
    if (!domain) return;
    try {
        await getDatabase().tag.update({ where: { id: tagId }, data: { domainKey: domain } });
    } catch {
        // ignore — the tag may have been deleted meanwhile
    }
}

/**
 * Returns the IDs of users who have an unresponded pending like on `userId`.
 * Not cached — incoming likes must be reflected immediately.
 * Capped at 500 to bound the Prisma `notIn` / `in` clause size.
 */
async function getIncomingLikerIds(userId: string, db: ReturnType<typeof getDatabase>): Promise<string[]> {
    const rows = await db.match.findMany({
        where: { receiverId: userId, category: 'like', mutual: false },
        select: { senderId: true },
        take: 500
    });
    return rows.map((r) => r.senderId);
}

/**
 * Build the shared context for the discovery pipeline (user, settings, exclusion list).
 * Call once, then pass the result to `runPipelineQuery` for each intention / filter set.
 */
export async function buildPipelineContext(client: Client): Promise<PipelineSetup> {
    // ── Level 2 cache: PipelineSetup (user + settings, excludeIds NOT cached) ─
    const cached = await getPipelineSetup(client.userId);
    if (cached) {
        const [excludeIds, incomingLikerIds] = await Promise.all([
            getExcludeIds(client.userId),
            getIncomingLikerIds(client.userId, getDatabase())
        ]);
        logger.debug(
            `[Pipeline] Setup cache hit for ${client.userId} (${excludeIds.length} excluded, ${incomingLikerIds.length} likers)`
        );
        return { ...cached, excludeIds, incomingLikerIds };
    }

    const db = getDatabase();

    const [currentUser, settings] = await Promise.all([
        db.user.findUnique({
            where: { id: client.userId },
            include: { profile: true, photos: true, tags: { include: { tag: true } } }
        }),
        db.settings.findUnique({ where: { userId: client.userId } })
    ]);

    const mixBots = await isFeatureEnabled('stresstest.bot_user_mixing');

    const myIntentionKeys = normalizeActiveIntentionKeys(currentUser?.profile?.intentionKeys ?? []);
    const myIntentionCategoryKeys = normalizeActiveIntentionCategoryKeys(
        currentUser?.profile?.intentionCategoryKeys ?? []
    );
    const {
        interestLabels: myInterestLabels,
        skillLabels: mySkillLabels,
        domainCounts: myDomainCounts
    } = buildTagScoringData(currentUser?.tags);
    const myLatLng = {
        latitude: currentUser?.profile?.latitude ?? null,
        longitude: currentUser?.profile?.longitude ?? null
    };
    const myGender = currentUser?.gender ?? '';
    const myAge = computeAge(currentUser?.birthDate ?? null);
    const myLanguages = currentUser?.profile?.spokenLanguages ?? [];
    const myPreferredPeriod = (currentUser?.preferredPeriod ?? 'any') as PreferredPeriod;
    const mySocialVibe = (currentUser?.profile?.socialVibe ?? 'balanced') as SocialVibe;
    const myProfileComplete = currentUser ? isProfileComplete(currentUser) : false;

    const prefAgeMin = settings?.peopleAgeMin ?? 18;
    const prefAgeMax = settings?.peopleAgeMax ?? 99;
    const prefGenders = settings?.peopleGenders ?? [];
    const prefVerified = settings?.peopleVerified ?? false;
    const prefLanguages = settings?.peopleLanguages ?? [];
    const storedMaxDistance = settings?.peopleMaxDistance ?? DEFAULT_MAX_DISTANCE;
    const storedRemote = settings?.peopleRemoteMode ?? false;

    // ── Level 3 cache: excludeIds via Redis Set / incomingLikerIds from DB ─
    const [excludeIds, incomingLikerIds] = await Promise.all([
        getExcludeIds(client.userId),
        getIncomingLikerIds(client.userId, db)
    ]);

    logger.debug(
        `[Pipeline] Setup for ${client.userId}: ${myIntentionKeys.length} intentions, ${excludeIds.length} excluded, ${incomingLikerIds.length} likers, profileComplete=${myProfileComplete}`
    );

    const setup: PipelineSetup = {
        myIntentionKeys,
        myIntentionCategoryKeys,
        myInterestLabels,
        mySkillLabels,
        myDomainCounts,
        myLatLng,
        myGender,
        myAge,
        myLanguages,
        myPreferredPeriod,
        mySocialVibe,
        myProfileComplete,
        myIsBot: currentUser?.bot ?? false,
        mixBots,
        prefAgeMin,
        prefAgeMax,
        prefGenders,
        prefVerified,
        prefLanguages,
        storedMaxDistance,
        storedRemote,
        excludeIds,
        incomingLikerIds
    };

    // Store setup in cache (without excludeIds/incomingLikerIds — those are always fetched fresh)
    await setPipelineSetup(client.userId, { ...setup, excludeIds: [], incomingLikerIds: [] });

    return setup;
}

/**
 * Build the Prisma WHERE clause for the discovery pipeline.
 * Extracted so it can be reused for both full queries and COUNT-only queries.
 */
function buildPipelineWhere(
    setup: PipelineSetup,
    filters?: SearchFilters,
    prefIntentionKeys?: IntentionKey[],
    prefRemote?: boolean
): Record<string, unknown> {
    const prefMaxDistance = filters?.maxDistance ?? setup.storedMaxDistance;
    const where: Record<string, unknown> = {
        id: { notIn: setup.excludeIds },
        banned: false,
        suspended: false,
        deleted: false,
        underageDeclared: false,
        // Synthetic stresstest accounts only see other synthetic accounts;
        // real accounts never see bots. Bypassed when `stresstest.bot_user_mixing`
        // is enabled (driven by the global feature flag).
        ...(setup.mixBots ? {} : { bot: setup.myIsBot }),
        birthDate: { not: null },
        photos: { some: {} },
        name: { not: '' },
        gender: { not: '' },
        AND: [{ tags: { some: { type: 'interest' } } }, { tags: { some: { type: 'skill' } } }]
    };

    const profileWhere: Record<string, unknown> = {
        bio: { not: '' },
        intentionKeys: { isEmpty: false },
        socialVibe: { in: [...SOCIAL_VIBES] },
        spokenLanguages: { isEmpty: false },
        latitude: { not: null },
        longitude: { not: null }
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

    // ── Intention filter ──
    // A candidate matches if either:
    //   - their `intentionKeys` overlap the leaves we're looking for, OR
    //   - their `intentionCategoryKeys` overlap the categories we're looking for
    //     (they expressed a category-global interest covering us).
    // We compute (leafKeysToMatch, categoryKeysToMatch) per branch and inject
    // an AND-clause with an OR on the two columns. Leaving `intentionKeys` /
    // `intentionCategoryKeys` defaults (isEmpty: false) in profileWhere is
    // incompatible with the category-only candidates → we drop the default
    // when we apply this filter.
    let leafKeysToMatch: IntentionKey[] | undefined;
    let categoryKeysToMatch: IntentionCategoryKey[] | undefined;

    if (prefIntentionKeys && prefIntentionKeys.length > 0) {
        leafKeysToMatch = normalizeIntentionKeysForQuery(prefIntentionKeys);
        const cats = new Set<IntentionCategoryKey>();
        for (const key of prefIntentionKeys) cats.add(getCategoryKeyForIntention(key));
        categoryKeysToMatch = [...cats];
    } else if (filters?.categoryKey) {
        leafKeysToMatch = normalizeIntentionKeysForQuery(
            getAllIntentionsForCategory(filters.categoryKey).map((intention) => intention.key)
        );
        categoryKeysToMatch = [filters.categoryKey];
    } else if (setup.myIntentionKeys.length > 0 || setup.myIntentionCategoryKeys.length > 0) {
        leafKeysToMatch = normalizeIntentionKeysForQuery(setup.myIntentionKeys);
        categoryKeysToMatch = setup.myIntentionCategoryKeys.length > 0 ? [...setup.myIntentionCategoryKeys] : undefined;
    }

    if ((leafKeysToMatch && leafKeysToMatch.length > 0) || (categoryKeysToMatch && categoryKeysToMatch.length > 0)) {
        const orBranches: Record<string, unknown>[] = [];
        if (leafKeysToMatch && leafKeysToMatch.length > 0) {
            orBranches.push({ intentionKeys: { hasSome: leafKeysToMatch } });
        }
        if (categoryKeysToMatch && categoryKeysToMatch.length > 0) {
            orBranches.push({ intentionCategoryKeys: { hasSome: categoryKeysToMatch } });
        }
        // Replace the default `intentionKeys: { isEmpty: false }` baseline by
        // the OR clause: a profile with only intentionCategoryKeys is valid.
        delete profileWhere.intentionKeys;
        profileWhere.OR = orBranches;
    }

    if (prefRemote && filters?.languages && filters.languages.length > 0) {
        profileWhere.spokenLanguages = { hasSome: filters.languages };
    } else if (prefRemote && setup.prefLanguages.length > 0) {
        profileWhere.spokenLanguages = { hasSome: setup.prefLanguages };
    }

    if (!prefRemote) {
        const bbox = geoBoundingBox(setup.myLatLng.latitude, setup.myLatLng.longitude, prefMaxDistance);
        if (bbox) {
            profileWhere.latitude = bbox.latitude;
            profileWhere.longitude = bbox.longitude;
        }
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

        if (setup.incomingLikerIds.length > 0) {
            // Someone who already liked me clearly wants to be found by me — bypass their
            // visibility settings. We push an AND condition so other filters still apply.
            (where.AND as unknown[]).push({
                OR: [{ id: { in: setup.incomingLikerIds } }, { settings: { AND: visibilityFilter } }]
            });
        } else {
            where.settings = { AND: visibilityFilter };
        }
    }

    // ── Tags filter (user must have at least one matching tag) ───
    if (filters?.tags && filters.tags.length > 0) {
        const lowers = filters.tags.map((t) => t.toLowerCase());
        where.tags = {
            some: {
                labelLower: { in: lowers }
            }
        };
    }

    // ── Social vibe ad-hoc filter ────────────────────────────────
    if (filters?.socialVibes && filters.socialVibes.length > 0) {
        profileWhere.socialVibe = { in: filters.socialVibes };
        where.profile = profileWhere;
    }

    // ── Preferred period ad-hoc filter ───────────────────────────
    if (filters?.preferredPeriods && filters.preferredPeriods.length > 0) {
        where.preferredPeriod = { in: filters.preferredPeriods };
    }

    // ── Free-text query filter (name or bio contains text) ───────
    if (filters?.query && filters.query.trim() !== '') {
        const q = filters.query.trim();
        where.OR = [
            { name: { contains: q, mode: 'insensitive' } },
            { profile: { bio: { contains: q, mode: 'insensitive' } } }
        ];
    }

    return where;
}

/**
 * Run the SQL query + scoring pipeline using a pre-built context.
 * `filters` override stored preferences (intentions, distance, remote, languages).
 *
 * This is the SINGLE source of truth for "how many candidates match these filters".
 * The returned `qualified.length` is what every screen (carte/swipe/recherche) displays.
 */
export async function runPipelineQuery(
    setup: PipelineSetup,
    filters?: SearchFilters,
    fetchLimit: number = 100
): Promise<{ qualified: QualifiedCandidate[]; ctx: PipelineContext }> {
    const db = getDatabase();

    const prefMaxDistance = filters?.maxDistance ?? setup.storedMaxDistance;
    const prefRemote = filters?.remote ?? setup.storedRemote;
    const prefIntentionKeys = normalizeActiveIntentionKeys(
        filters?.intentionKeys ?? (filters?.intentionKey ? [filters.intentionKey] : undefined)
    );

    const where = buildPipelineWhere(
        setup,
        filters,
        prefIntentionKeys.length > 0 ? prefIntentionKeys : undefined,
        prefRemote
    );

    // ── Level 1 cache: candidate profiles ───────────────────────────────────
    // Step 1: lightweight ID scan (no JOINs)
    const idRows = await db.user.findMany({
        where,
        select: { id: true },
        orderBy: { createdAt: 'desc' },
        take: fetchLimit
    });
    const ids = idRows.map((r) => r.id);

    // Step 2: cache lookup
    const cachedMap = await getCandidates(ids);
    const missIds = ids.filter((id) => !cachedMap.has(id));

    // Step 3: DB fetch for misses (full JOINs only for uncached rows)
    if (missIds.length > 0) {
        const freshUsers = await db.user.findMany({
            where: { id: { in: missIds } },
            include: candidateQueryInclude
        });
        await setCandidates(freshUsers as unknown as Record<string, unknown>[]);
        freshUsers.forEach((u) => cachedMap.set(u.id, u as unknown as Record<string, unknown>));
    }

    // Step 4: reconstruct ordered list
    const users = ids.map((id) => cachedMap.get(id)).filter(Boolean) as unknown as CandidateUser[];

    logger.debug(
        `[Pipeline] Candidates: ${ids.length} IDs, ${missIds.length} DB misses, ${ids.length - missIds.length} cache hits`
    );

    // ── Score & post-filter ──────────────────────────────────────
    const scoringCtx: ScoringContext = {
        myIntentionKeys: setup.myIntentionKeys,
        targetCategoryKey: filters?.categoryKey,
        targetIntentionKey: filters?.intentionKey,
        targetIntentionKeys: prefIntentionKeys.length > 0 ? prefIntentionKeys : undefined,
        myInterestLabels: setup.myInterestLabels,
        mySkillLabels: setup.mySkillLabels,
        myDomainCounts: setup.myDomainCounts,
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
            const theirIntentionKeys = normalizeActiveIntentionKeys(u.profile?.intentionKeys ?? []);
            const theirTagData = buildTagScoringData(u.tags);
            const distKm = getDistanceKm(
                setup.myLatLng.latitude,
                setup.myLatLng.longitude,
                u.profile?.latitude,
                u.profile?.longitude
            );

            const candidate: ScoringCandidate = {
                intentionKeys: theirIntentionKeys,
                intentionCategoryKeys: normalizeActiveIntentionCategoryKeys(u.profile?.intentionCategoryKeys ?? []),
                interestLabels: theirTagData.interestLabels,
                skillLabels: theirTagData.skillLabels,
                domainCounts: theirTagData.domainCounts,
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
            const intentionMatch = buildIntentionMatchSummary(scoringCtx, candidate, breakdown);

            return {
                user: u as CandidateUser,
                intentionKeys: theirIntentionKeys,
                intentionMatch,
                score: breakdown.total,
                distKm
            } satisfies QualifiedCandidate;
        })
        .filter((s) => isProfileComplete(s.user))
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

    const queryScope = prefIntentionKeys.length > 0 ? prefIntentionKeys.join(',') : (filters?.categoryKey ?? 'all');
    logger.debug(
        `[Pipeline] Query(${queryScope}): ${users.length} fetched → ${qualified.length} qualified (limit=${fetchLimit})`
    );

    return {
        qualified,
        ctx: {
            myIntentionKeys: setup.myIntentionKeys,
            myProfileComplete: setup.myProfileComplete,
            prefCategoryKey: filters?.categoryKey,
            prefIntentionKeys: prefIntentionKeys.length > 0 ? prefIntentionKeys : undefined,
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
    const exact = await runPipelineQuery(setup, filters, fetchLimit);

    if (!filters?.intentionKey || exact.qualified.length >= MIN_EXACT_INTENTION_RESULTS) {
        return exact;
    }

    const seen = new Set(exact.qualified.map((candidate) => candidate.user.id));
    const expanded = [...exact.qualified];
    const fallbackSteps: Array<{ label: string; filters: SearchFilters }> = [];

    const parentKey = getParentKeyForIntention(filters.intentionKey);
    if (isIntentionKey(parentKey)) {
        fallbackSteps.push({
            label: parentKey,
            filters: {
                ...filters,
                categoryKey: filters.categoryKey ?? getCategoryKeyForIntention(parentKey),
                intentionKey: parentKey,
                intentionKeys: undefined
            }
        });
    }

    const fallbackCategoryKey = filters.categoryKey ?? getCategoryKeyForIntention(filters.intentionKey);
    fallbackSteps.push({
        label: fallbackCategoryKey,
        filters: {
            ...filters,
            categoryKey: fallbackCategoryKey,
            intentionKey: undefined,
            intentionKeys: undefined
        }
    });

    for (const step of fallbackSteps) {
        if (expanded.length >= MIN_EXACT_INTENTION_RESULTS) break;
        const fallback = await runPipelineQuery(setup, step.filters, fetchLimit);
        for (const candidate of fallback.qualified) {
            if (seen.has(candidate.user.id)) continue;
            seen.add(candidate.user.id);
            expanded.push(candidate);
        }

        if (expanded.length > exact.qualified.length) {
            logger.debug(
                `[Pipeline] Expanded low-supply intention ${filters.intentionKey} from ${exact.qualified.length} to ${expanded.length} candidates via ${step.label}`
            );
        }
    }

    return { qualified: expanded, ctx: exact.ctx };
}
