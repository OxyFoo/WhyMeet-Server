import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

type UsageLimitConfig = {
    searchDailyFree: number;
    searchDailyPremium: number;
    swipeDailyFree: number;
    swipeDailyPremium: number;
    activityOpenDailyFree: number;
    activityOpenDailyPremium: number;
    initialSearchTokens: number;
    subscriptionBoostDays: number;
};

const APP_CONFIG_KEYS = {
    searchDailyFree: 'counter.search.daily.free',
    searchDailyPremium: 'counter.search.daily.premium',
    swipeDailyFree: 'counter.swipe.daily.free',
    swipeDailyPremium: 'counter.swipe.daily.premium',
    activityOpenDailyFree: 'counter.activity_open.daily.free',
    activityOpenDailyPremium: 'counter.activity_open.daily.premium',
    initialSearchTokens: 'counter.search.initial',
    subscriptionBoostDays: 'subscription.boost.days'
} as const;

const CACHE_TTL_MS = 10_000;

type CachedConfig = {
    expiresAt: number;
    values: UsageLimitConfig;
};

let cache: CachedConfig | null = null;

const DEFAULT_USAGE_LIMITS: UsageLimitConfig = {
    searchDailyFree: 3,
    searchDailyPremium: 20,
    swipeDailyFree: 20,
    swipeDailyPremium: -1,
    activityOpenDailyFree: 3,
    activityOpenDailyPremium: 25,
    initialSearchTokens: 5,
    subscriptionBoostDays: 10
};

function defaults(): UsageLimitConfig {
    return DEFAULT_USAGE_LIMITS;
}

function normalizeNonNegative(value: number, fallback: number): number {
    return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function normalizeLimit(value: number, fallback: number): number {
    return Number.isInteger(value) && (value >= 0 || value === -1) ? value : fallback;
}

export async function getUsageLimitConfig(): Promise<UsageLimitConfig> {
    const now = Date.now();
    if (cache && cache.expiresAt > now) return cache.values;

    const fallback = defaults();

    try {
        const db = getDatabase();
        const keys = Object.values(APP_CONFIG_KEYS) as string[];
        const rows = await db.appConfig.findMany({ where: { key: { in: keys } } });
        const byKey = new Map(rows.map((r) => [r.key, r.valueInt]));

        const values: UsageLimitConfig = {
            searchDailyFree: normalizeNonNegative(
                byKey.get(APP_CONFIG_KEYS.searchDailyFree) ?? fallback.searchDailyFree,
                fallback.searchDailyFree
            ),
            searchDailyPremium: normalizeNonNegative(
                byKey.get(APP_CONFIG_KEYS.searchDailyPremium) ?? fallback.searchDailyPremium,
                fallback.searchDailyPremium
            ),
            swipeDailyFree: normalizeLimit(
                byKey.get(APP_CONFIG_KEYS.swipeDailyFree) ?? fallback.swipeDailyFree,
                fallback.swipeDailyFree
            ),
            swipeDailyPremium: normalizeLimit(
                byKey.get(APP_CONFIG_KEYS.swipeDailyPremium) ?? fallback.swipeDailyPremium,
                fallback.swipeDailyPremium
            ),
            activityOpenDailyFree: normalizeNonNegative(
                byKey.get(APP_CONFIG_KEYS.activityOpenDailyFree) ?? fallback.activityOpenDailyFree,
                fallback.activityOpenDailyFree
            ),
            activityOpenDailyPremium: normalizeNonNegative(
                byKey.get(APP_CONFIG_KEYS.activityOpenDailyPremium) ?? fallback.activityOpenDailyPremium,
                fallback.activityOpenDailyPremium
            ),
            initialSearchTokens: normalizeNonNegative(
                byKey.get(APP_CONFIG_KEYS.initialSearchTokens) ?? fallback.initialSearchTokens,
                fallback.initialSearchTokens
            ),
            subscriptionBoostDays: normalizeNonNegative(
                byKey.get(APP_CONFIG_KEYS.subscriptionBoostDays) ?? fallback.subscriptionBoostDays,
                fallback.subscriptionBoostDays
            )
        };

        cache = { values, expiresAt: now + CACHE_TTL_MS };
        return values;
    } catch (error) {
        logger.warn('[UsageLimits] Failed to load app config, using defaults', error);
        return cache?.values ?? fallback;
    }
}

export function clearUsageLimitConfigCache(): void {
    cache = null;
}
