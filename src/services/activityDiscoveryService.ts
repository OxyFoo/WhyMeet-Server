import type {
    ActivitySummary,
    ActivitySearchFilters,
    InterestCategoryKey,
    Gender,
    SwipeQuotaInfo
} from '@oxyfoo/whymeet-types';
import { Prisma } from '@prisma/client';
import { getDatabase } from '@/services/database';
import { getDistanceKm, geoBoundingBox, computeAge } from '@/services/userMapper';
import { isFeatureEnabled } from '@/services/featureFlagService';
import { getRedis, isRedisAvailable } from '@/services/redisService';
import { INTEREST_CATEGORY_KEYS } from '@oxyfoo/whymeet-types';
import { isProfileComplete, loadUserForCompletion } from '@/services/profileCompletion';
import { obfuscateString } from '@/services/previewObfuscation';
import { getSwipeQuota } from '@/services/swipeQuotaService';
import { logger } from '@/config/logger';
import { decodeCursor, encodeCursor, resolveLimit } from '@/services/cursorPagination';

const ACTIVITY_CACHE_PREFIX = 'activity:discovery:v2:';
const ACTIVITY_CACHE_REVISION_KEY = `${ACTIVITY_CACHE_PREFIX}revision`;
const VIEWER_CONTEXT_TTL_MS = 30_000;
const ACTIVITY_COUNTS_TTL_S = 60;
const POPULAR_ACTIVITY_TAGS_TTL_S = 600;
const POPULAR_ACTIVITY_TAG_LIMIT = 20;

const viewerContextCache = new Map<string, { expiresAt: number; value: ViewerContext }>();
const activityCacheInFlight = new Map<string, Promise<unknown>>();
let localActivityCacheRevision = 0;

interface ViewerContext {
    latitude: number | null;
    longitude: number | null;
    gender: string | null;
    birthDate: Date | null;
    myProfileComplete: boolean;
    /** Synthetic stresstest account flag — bots only see other bots' activities. */
    isBot: boolean;
    /** When true, the bot/user isolation is broken (stresstest.bot_user_mixing). */
    mixBots: boolean;
    activityGenders: string[];
    activityMaxDistance: number;
    activityRemoteMode: boolean;
    activityVerified: boolean;
    activityLanguages: string[];
}

const activitySummaryInclude = {
    host: { select: { name: true } },
    participants: { select: { userId: true } },
    photos: { orderBy: { position: 'asc' as const }, take: 1 }
} as const;

type ActivitySummaryRow = Prisma.ActivityGetPayload<{ include: typeof activitySummaryInclude }>;

type ActivityIdRow = { id: string; totalCount: number | bigint; sortKey: Date };
type ActivityCountRow = { category: string; count: number | bigint };
type ActivityTagRow = { label: string };

type ActivityObfuscationMode = 'auto' | 'force' | 'clear';

interface ActivityDiscoveryContext {
    swipeQuota?: SwipeQuotaInfo;
}

interface ActivityDiscoveryOptions {
    /**
     * `auto`: default discovery behavior, obfuscate when the profile is incomplete or the swipe quota is exhausted.
     * `force`: preview behavior, always obfuscate the returned cards regardless of profile completion.
     * `clear`: always return the cards in clear, even if the viewer profile is incomplete.
     */
    obfuscationMode?: ActivityObfuscationMode;
    discoveryContext?: ActivityDiscoveryContext;
    cursor?: string;
    limit?: number;
}

function activityCountsKey(userId: string, revision: string): string {
    return `${ACTIVITY_CACHE_PREFIX}${revision}:counts:${userId}`;
}

function activityPopularTagsKey(userId: string, category: InterestCategoryKey, revision: string): string {
    return `${ACTIVITY_CACHE_PREFIX}${revision}:popular-tags:${userId}:${category}`;
}

function clearViewerInFlight(userId: string): void {
    for (const key of activityCacheInFlight.keys()) {
        if (key.endsWith(`:counts:${userId}`) || key.includes(`:popular-tags:${userId}:`)) {
            activityCacheInFlight.delete(key);
        }
    }
}

async function getCachedJson<T>(key: string): Promise<T | null> {
    if (!isRedisAvailable()) return null;

    try {
        const raw = await getRedis().get(key);
        if (!raw) return null;
        return JSON.parse(raw) as T;
    } catch (error) {
        logger.warn('[ActivityDiscovery] Redis error on get', error);
        return null;
    }
}

async function getActivityCacheRevision(): Promise<string> {
    if (!isRedisAvailable()) return String(localActivityCacheRevision);

    try {
        return (await getRedis().get(ACTIVITY_CACHE_REVISION_KEY)) ?? '0';
    } catch (error) {
        logger.warn('[ActivityDiscovery] Redis error on revision get', error);
        return String(localActivityCacheRevision);
    }
}

async function getOrComputeCached<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T> {
    const cached = await getCachedJson<T>(key);
    if (cached) return cached;

    const pending = activityCacheInFlight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const promise = (async () => {
        const rechecked = await getCachedJson<T>(key);
        if (rechecked) return rechecked;

        const value = await compute();
        if (isRedisAvailable()) {
            try {
                await getRedis().set(key, JSON.stringify(value), 'EX', ttlSeconds);
            } catch (error) {
                logger.warn('[ActivityDiscovery] Redis error on set', error);
                // Cache failures must never block activity discovery.
            }
        }
        return value;
    })().finally(() => {
        activityCacheInFlight.delete(key);
    });

    activityCacheInFlight.set(key, promise);
    return promise;
}

export async function invalidateActivityDiscoveryCache(userId: string): Promise<void> {
    viewerContextCache.delete(userId);
    clearViewerInFlight(userId);
    if (!isRedisAvailable()) return;

    try {
        const revision = await getActivityCacheRevision();
        const keys = [
            activityCountsKey(userId, revision),
            ...INTEREST_CATEGORY_KEYS.map((category) => activityPopularTagsKey(userId, category, revision))
        ];
        await getRedis().del(...keys);
    } catch (error) {
        logger.warn('[ActivityDiscovery] Redis error on viewer invalidation', error);
        // Best-effort cache invalidation.
    }
}

export async function invalidateActivityCatalogCache(): Promise<void> {
    activityCacheInFlight.clear();
    localActivityCacheRevision++;

    if (!isRedisAvailable()) return;

    try {
        await getRedis().incr(ACTIVITY_CACHE_REVISION_KEY);
    } catch (error) {
        logger.warn('[ActivityDiscovery] Redis error on catalog invalidation', error);
    }
}

async function loadViewerContext(userId: string): Promise<ViewerContext> {
    const cached = viewerContextCache.get(userId);
    if (cached && Date.now() < cached.expiresAt) return cached.value;

    const db = getDatabase();
    const [user, settings, mixBots] = await Promise.all([
        loadUserForCompletion(userId),
        db.settings.findUnique({ where: { userId } }),
        isFeatureEnabled('stresstest.bot_user_mixing')
    ]);

    const context: ViewerContext = {
        latitude: user?.profile?.latitude ?? null,
        longitude: user?.profile?.longitude ?? null,
        gender: user?.gender ?? null,
        birthDate: user?.birthDate ?? null,
        myProfileComplete: user ? isProfileComplete(user) : false,
        isBot: user?.bot ?? false,
        mixBots,
        activityGenders: settings?.activityGenders ?? [],
        activityMaxDistance: settings?.activityMaxDistance ?? 50,
        activityRemoteMode: settings?.activityRemoteMode ?? false,
        activityVerified: settings?.activityVerified ?? false,
        activityLanguages: settings?.activityLanguages ?? []
    };

    viewerContextCache.set(userId, { expiresAt: Date.now() + VIEWER_CONTEXT_TTL_MS, value: context });
    return context;
}

/** Returns true if the viewer's age is within the activity's targetAgeRange.
 * If viewer has no birthDate, we include the activity (benefit of the doubt).
 * If targetAgeRange[1] >= 80, treat it as "80+" (no upper bound).
 * Exported for unit testing. */
export function passesAgeFilter(birthDate: Date | null, targetAgeRange: number[]): boolean {
    if (!birthDate || targetAgeRange.length < 2) return true;
    const age = computeAge(birthDate);
    const [min, max] = targetAgeRange;
    if (age < min) return false;
    if (max < 80 && age > max) return false;
    return true;
}

function resolveEffectiveMaxDistance(viewer: ViewerContext, filters?: ActivitySearchFilters): number | undefined {
    return filters?.maxDistance ?? (viewer.activityRemoteMode ? undefined : viewer.activityMaxDistance);
}

function normalizedTags(tags: readonly string[] | undefined): string[] {
    return [...new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

function buildActivityDiscoveryWhere(
    userId: string,
    viewer: ViewerContext,
    filters?: ActivitySearchFilters
): Prisma.Sql {
    const clauses: Prisma.Sql[] = [
        Prisma.sql`a."isCancelled" = false`,
        Prisma.sql`a."isArchived" = false`,
        Prisma.sql`host.banned = false`,
        Prisma.sql`host.suspended = false`,
        Prisma.sql`host.deleted = false`,
        Prisma.sql`host."underageDeclared" = false`,
        Prisma.sql`NOT EXISTS (
            SELECT 1
            FROM activity_reports ar
            WHERE ar."activityId" = a.id AND ar."reporterId" = ${userId}
        )`
    ];

    if (!viewer.mixBots) {
        clauses.push(Prisma.sql`host.bot = ${viewer.isBot}`);
    }

    if (viewer.activityGenders.length > 0) {
        clauses.push(Prisma.sql`host.gender IN (${Prisma.join(viewer.activityGenders)})`);
    }

    if (viewer.activityVerified) {
        clauses.push(Prisma.sql`host.verified = true`);
    }

    if (viewer.activityLanguages.length > 0) {
        clauses.push(Prisma.sql`hp."spokenLanguages" && ARRAY[${Prisma.join(viewer.activityLanguages)}]::text[]`);
    }

    if (viewer.gender) {
        clauses.push(Prisma.sql`${viewer.gender} = ANY(a."targetGenders")`);
    }

    if (filters?.category) {
        clauses.push(Prisma.sql`a.category = ${filters.category}`);
    }

    if (filters?.dateFrom) {
        clauses.push(Prisma.sql`a."dateTime" >= ${new Date(filters.dateFrom)}`);
    }

    if (filters?.dateTo) {
        clauses.push(Prisma.sql`a."dateTime" <= ${new Date(filters.dateTo)}`);
    }

    if (filters?.timeFromMin != null || filters?.timeToMin != null) {
        const offsetMin = filters.timezoneOffsetMin ?? 0;
        // Convert UTC dateTime to viewer-local minute-of-day in [0, 1440).
        // EXTRACT(EPOCH ...) gives seconds since epoch; divide by 60, add offset,
        // take modulo 1440 with double-modulo to ensure a non-negative result.
        const localMin = Prisma.sql`((((EXTRACT(EPOCH FROM a."dateTime")::bigint / 60) + ${offsetMin})::bigint % 1440 + 1440) % 1440)`;
        if (filters.timeFromMin != null) {
            clauses.push(Prisma.sql`${localMin} >= ${filters.timeFromMin}`);
        }
        if (filters.timeToMin != null) {
            clauses.push(Prisma.sql`${localMin} <= ${filters.timeToMin}`);
        }
    }

    const query = filters?.query?.trim();
    if (query) {
        const pattern = `%${query}%`;
        clauses.push(Prisma.sql`(a.title ILIKE ${pattern} OR a.description ILIKE ${pattern})`);
    }

    const tags = normalizedTags(filters?.tags);
    if (tags.length > 0) {
        clauses.push(Prisma.sql`EXISTS (
            SELECT 1
            FROM user_tags filter_tags
            WHERE filter_tags."userId" = host.id
              AND filter_tags.type = 'interest'
              AND filter_tags."labelLower" IN (${Prisma.join(tags)})
        )`);
    }

    const effectiveMaxDistance = resolveEffectiveMaxDistance(viewer, filters);
    if (effectiveMaxDistance != null && viewer.latitude != null && viewer.longitude != null) {
        const bbox = geoBoundingBox(viewer.latitude, viewer.longitude, effectiveMaxDistance);
        if (bbox) {
            clauses.push(Prisma.sql`a.latitude BETWEEN ${bbox.latitude.gte} AND ${bbox.latitude.lte}`);
            clauses.push(Prisma.sql`a.longitude BETWEEN ${bbox.longitude.gte} AND ${bbox.longitude.lte}`);
        }
        clauses.push(Prisma.sql`(
            6371 * acos(
                LEAST(1, GREATEST(-1,
                    cos(radians(${viewer.latitude})) * cos(radians(a.latitude)) *
                    cos(radians(a.longitude) - radians(${viewer.longitude})) +
                    sin(radians(${viewer.latitude})) * sin(radians(a.latitude))
                ))
            )
        ) <= ${effectiveMaxDistance}`);
    }

    if (viewer.birthDate) {
        const viewerAge = computeAge(viewer.birthDate);
        clauses.push(Prisma.sql`(
            COALESCE(array_length(a."targetAgeRange", 1), 0) < 2
            OR (
                (a."targetAgeRange")[1] <= ${viewerAge}
                AND ((a."targetAgeRange")[2] >= ${viewerAge} OR (a."targetAgeRange")[2] >= 80)
            )
        )`);
    }

    return Prisma.sql`WHERE ${Prisma.join(clauses, ' AND ')}`;
}

function activityDiscoveryFrom(): Prisma.Sql {
    return Prisma.sql`
        FROM activities a
        JOIN users host ON host.id = a."hostId"
        LEFT JOIN profiles hp ON hp."userId" = host.id
    `;
}

function mapActivitySummary(
    activity: ActivitySummaryRow,
    viewerLat?: number | null,
    viewerLng?: number | null,
    photoKeyMode: 'clear' | 'blurred' = 'clear'
): ActivitySummary {
    const distKm = getDistanceKm(viewerLat, viewerLng, activity.latitude, activity.longitude);
    const distStr = distKm != null ? (distKm < 1 ? '< 1 km' : `${Math.round(distKm)} km`) : undefined;

    const photo = activity.photos[0];
    const photoKey = photo?.key ?? null;
    const photoKeyBlurred = photo?.keyBlurred ?? null;

    return {
        id: activity.id,
        title: activity.title,
        category: activity.category as InterestCategoryKey,
        dateTime: activity.dateTime?.toISOString() ?? null,
        durationMinutes: activity.durationMinutes,
        locationName: activity.locationName,
        participantCount: activity.participants.length,
        maxParticipants: activity.maxParticipants,
        photoKey: photoKeyMode === 'blurred' ? photoKeyBlurred : photoKey,
        hostName: activity.host.name,
        targetGenders: activity.targetGenders as Gender[],
        targetAgeRange: (activity.targetAgeRange?.length === 2 ? activity.targetAgeRange : [18, 80]) as [
            number,
            number
        ],
        distance: distStr,
        distanceKm: distKm ?? undefined
    };
}

function obfuscateActivitySummary(activity: ActivitySummary): ActivitySummary {
    return {
        ...activity,
        title: obfuscateString(activity.title),
        locationName: obfuscateString(activity.locationName),
        hostName: obfuscateString(activity.hostName),
        blurred: true
    };
}

function isSwipeQuotaExhausted(quota: SwipeQuotaInfo): boolean {
    return quota.dailyLimit !== -1 && quota.remaining <= 0;
}

async function shouldObfuscateActivityCards(
    userId: string,
    viewer: ViewerContext,
    options: ActivityDiscoveryOptions
): Promise<boolean> {
    const obfuscationMode = options.obfuscationMode ?? 'auto';
    if (obfuscationMode === 'force') return true;
    if (obfuscationMode === 'clear') return false;
    if (!viewer.myProfileComplete) return true;

    const quota = options.discoveryContext?.swipeQuota ?? (await getSwipeQuota(userId));
    return isSwipeQuotaExhausted(quota);
}

// ─── Get Activities ──────────────────────────────────────────────────

const ACTIVITY_NULL_DATE_SENTINEL = '9999-12-31T00:00:00.000Z';

export async function getActivities(
    userId: string,
    filters?: ActivitySearchFilters,
    options: ActivityDiscoveryOptions = {}
): Promise<{
    activities: ActivitySummary[];
    totalCount: number;
    nextCursor: string | null;
}> {
    const db = getDatabase();
    const viewer = await loadViewerContext(userId);
    const where = buildActivityDiscoveryWhere(userId, viewer, filters);
    const limit = resolveLimit(options.limit);
    const decoded = decodeCursor(options.cursor);

    // Keyset filter using the same `(COALESCE(dateTime, sentinel), id)` tuple
    // that drives the ORDER BY below. Anything strictly after the cursor
    // tuple is part of the next page.
    const cursorClause = decoded
        ? Prisma.sql`AND (
            COALESCE(a."dateTime", ${ACTIVITY_NULL_DATE_SENTINEL}::timestamptz) > ${new Date(decoded.k)}::timestamptz
            OR (
                COALESCE(a."dateTime", ${ACTIVITY_NULL_DATE_SENTINEL}::timestamptz) = ${new Date(decoded.k)}::timestamptz
                AND a.id > ${decoded.i}
            )
        )`
        : Prisma.empty;

    const rows = await db.$queryRaw<ActivityIdRow[]>(Prisma.sql`
        SELECT
            a.id,
            COALESCE(a."dateTime", ${ACTIVITY_NULL_DATE_SENTINEL}::timestamptz) AS "sortKey",
            COUNT(*) OVER()::integer AS "totalCount"
        ${activityDiscoveryFrom()}
        ${where}
        ${cursorClause}
        ORDER BY COALESCE(a."dateTime", ${ACTIVITY_NULL_DATE_SENTINEL}::timestamptz) ASC, a.id ASC
        LIMIT ${limit + 1}
    `);

    const totalCount = Number(rows[0]?.totalCount ?? 0);
    if (rows.length === 0) {
        return { activities: [], totalCount, nextCursor: null };
    }

    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const last = sliced[sliced.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.sortKey, last.id) : null;
    const ids = sliced.map((row) => row.id);

    const activityRecords = await db.activity.findMany({
        where: { id: { in: ids } },
        include: activitySummaryInclude
    });

    const byId = new Map(activityRecords.map((activity) => [activity.id, activity]));
    const shouldObfuscate = await shouldObfuscateActivityCards(userId, viewer, options);

    const summaries = ids
        .map((id) => byId.get(id))
        .filter((activity): activity is ActivitySummaryRow => Boolean(activity))
        .map((activity) =>
            mapActivitySummary(activity, viewer.latitude, viewer.longitude, shouldObfuscate ? 'blurred' : 'clear')
        );

    const activities = shouldObfuscate ? summaries.map(obfuscateActivitySummary) : summaries;

    return { activities, totalCount, nextCursor };
}

// ─── Get Activity Counts ────────────────────────────────────────────

export async function getActivityCounts(userId: string): Promise<Record<string, number>> {
    const revision = await getActivityCacheRevision();
    return getOrComputeCached(activityCountsKey(userId, revision), ACTIVITY_COUNTS_TTL_S, async () =>
        computeActivityCounts(userId)
    );
}

async function computeActivityCounts(userId: string): Promise<Record<string, number>> {
    const db = getDatabase();
    const viewer = await loadViewerContext(userId);

    const counts: Record<string, number> = {};
    for (const key of INTEREST_CATEGORY_KEYS) counts[key] = 0;

    const rows = await db.$queryRaw<ActivityCountRow[]>(Prisma.sql`
        SELECT a.category, COUNT(*)::integer AS count
        ${activityDiscoveryFrom()}
        ${buildActivityDiscoveryWhere(userId, viewer)}
        GROUP BY a.category
    `);

    for (const row of rows) {
        if (row.category in counts) counts[row.category] = Number(row.count);
    }

    return counts;
}

// ─── Search Activities ──────────────────────────────────────────────

export async function searchActivities(
    userId: string,
    filters: ActivitySearchFilters,
    options?: ActivityDiscoveryOptions
): Promise<{ activities: ActivitySummary[]; totalCount: number; nextCursor: string | null }> {
    // Search reuses getActivities with the filters
    return getActivities(userId, filters, options);
}

// ─── Get Popular Activity Tags ──────────────────────────────────────

export async function getPopularActivityTags(userId: string, category: InterestCategoryKey): Promise<string[]> {
    const revision = await getActivityCacheRevision();
    return getOrComputeCached(
        activityPopularTagsKey(userId, category, revision),
        POPULAR_ACTIVITY_TAGS_TTL_S,
        async () => computePopularActivityTags(userId, category)
    );
}

async function computePopularActivityTags(userId: string, category: InterestCategoryKey): Promise<string[]> {
    const db = getDatabase();
    const viewer = await loadViewerContext(userId);

    const rows = await db.$queryRaw<ActivityTagRow[]>(Prisma.sql`
        SELECT tags.label, COUNT(*)::integer AS count
        ${activityDiscoveryFrom()}
        JOIN user_tags tags ON tags."userId" = host.id AND tags.type = 'interest'
        ${buildActivityDiscoveryWhere(userId, viewer, { category })}
        GROUP BY tags.label
        ORDER BY count DESC, lower(tags.label) ASC
        LIMIT ${POPULAR_ACTIVITY_TAG_LIMIT}
    `);

    return rows.map((row) => row.label);
}

// ─── Get My Activities ──────────────────────────────────────────────

export interface GetMyActivitiesResult {
    activities: ActivitySummary[];
    nextCursor: string | null;
}

export async function getMyActivities(
    userId: string,
    role: 'host' | 'participant',
    options: { cursor?: string; limit?: number } = {}
): Promise<GetMyActivitiesResult> {
    const db = getDatabase();
    const limit = resolveLimit(options.limit);
    const decoded = decodeCursor(options.cursor);

    const viewerProfile = await db.profile.findUnique({
        where: { userId },
        select: { latitude: true, longitude: true }
    });

    const where: Prisma.ActivityWhereInput = {
        isCancelled: false,
        isArchived: false,
        ...(role === 'host' ? { hostId: userId } : { participants: { some: { userId } }, hostId: { not: userId } }),
        ...(decoded && {
            OR: [
                { createdAt: { lt: new Date(decoded.k) } },
                { AND: [{ createdAt: new Date(decoded.k) }, { id: { lt: decoded.i } }] }
            ]
        })
    };

    const rows = await db.activity.findMany({
        where,
        include: activitySummaryInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1
    });

    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const last = sliced[sliced.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

    return {
        activities: sliced.map((activity) =>
            mapActivitySummary(activity, viewerProfile?.latitude, viewerProfile?.longitude)
        ),
        nextCursor
    };
}
