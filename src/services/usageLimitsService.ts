import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';
import { isPremium } from '@/services/subscriptionService';

export type UsageLimitConfig = {
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
const QUOTA_EXEMPTION_CACHE_TTL_MS = 10_000;

type CachedConfig = {
    expiresAt: number;
    values: UsageLimitConfig;
};

type CachedQuotaExemption = {
    expiresAt: number;
    value: boolean;
};

let cache: CachedConfig | null = null;
const quotaExemptionCache = new Map<string, CachedQuotaExemption>();
const quotaExemptionLookups = new Map<string, Promise<boolean>>();

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

function unlimitedQuotas(config: UsageLimitConfig): UsageLimitConfig {
    return {
        ...config,
        searchDailyFree: -1,
        searchDailyPremium: -1,
        swipeDailyFree: -1,
        swipeDailyPremium: -1,
        activityOpenDailyFree: -1,
        activityOpenDailyPremium: -1,
        initialSearchTokens: -1
    };
}

async function hasQuotaExemption(userId: string): Promise<boolean> {
    const now = Date.now();
    const cached = quotaExemptionCache.get(userId);
    if (cached && cached.expiresAt > now) return cached.value;

    const pending = quotaExemptionLookups.get(userId);
    if (pending) return pending;

    const lookup = getDatabase()
        .user.findUnique({ where: { id: userId }, select: { bot: true } })
        .then((user) => {
            const value = user?.bot === true;
            quotaExemptionCache.set(userId, { value, expiresAt: Date.now() + QUOTA_EXEMPTION_CACHE_TTL_MS });
            return value;
        })
        .finally(() => {
            quotaExemptionLookups.delete(userId);
        });
    quotaExemptionLookups.set(userId, lookup);
    return lookup;
}

async function getEffectiveLimitContext(userId: string): Promise<{ config: UsageLimitConfig; premium: boolean }> {
    const [config, exempt] = await Promise.all([getUsageLimitConfig(), hasQuotaExemption(userId)]);
    if (exempt) return { config: unlimitedQuotas(config), premium: false };
    return { config, premium: await isPremium(userId) };
}

function normalizeNonNegative(value: number, fallback: number): number {
    return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function normalizePositive(value: number, fallback: number): number {
    return Number.isInteger(value) && value >= 1 ? value : fallback;
}

function normalizeNonNegativeOrUnlimited(value: number, fallback: number): number {
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
            searchDailyFree: normalizeNonNegativeOrUnlimited(
                byKey.get(APP_CONFIG_KEYS.searchDailyFree) ?? fallback.searchDailyFree,
                fallback.searchDailyFree
            ),
            searchDailyPremium: normalizeNonNegativeOrUnlimited(
                byKey.get(APP_CONFIG_KEYS.searchDailyPremium) ?? fallback.searchDailyPremium,
                fallback.searchDailyPremium
            ),
            swipeDailyFree: normalizeNonNegativeOrUnlimited(
                byKey.get(APP_CONFIG_KEYS.swipeDailyFree) ?? fallback.swipeDailyFree,
                fallback.swipeDailyFree
            ),
            swipeDailyPremium: normalizeNonNegativeOrUnlimited(
                byKey.get(APP_CONFIG_KEYS.swipeDailyPremium) ?? fallback.swipeDailyPremium,
                fallback.swipeDailyPremium
            ),
            activityOpenDailyFree: normalizeNonNegativeOrUnlimited(
                byKey.get(APP_CONFIG_KEYS.activityOpenDailyFree) ?? fallback.activityOpenDailyFree,
                fallback.activityOpenDailyFree
            ),
            activityOpenDailyPremium: normalizeNonNegativeOrUnlimited(
                byKey.get(APP_CONFIG_KEYS.activityOpenDailyPremium) ?? fallback.activityOpenDailyPremium,
                fallback.activityOpenDailyPremium
            ),
            initialSearchTokens: normalizeNonNegative(
                byKey.get(APP_CONFIG_KEYS.initialSearchTokens) ?? fallback.initialSearchTokens,
                fallback.initialSearchTokens
            ),
            subscriptionBoostDays: normalizePositive(
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
    quotaExemptionCache.clear();
    quotaExemptionLookups.clear();
}

export async function getSearchQuotaLimits(userId: string): Promise<{ dailyLimit: number; initialRemaining: number }> {
    const { config, premium } = await getEffectiveLimitContext(userId);
    return {
        dailyLimit: premium ? config.searchDailyPremium : config.searchDailyFree,
        initialRemaining: premium ? config.searchDailyPremium : config.initialSearchTokens
    };
}

export async function getSwipeDailyLimit(userId: string): Promise<number> {
    const { config, premium } = await getEffectiveLimitContext(userId);
    return premium ? config.swipeDailyPremium : config.swipeDailyFree;
}

export async function getActivityOpenDailyLimit(userId: string): Promise<number> {
    const { config, premium } = await getEffectiveLimitContext(userId);
    return premium ? config.activityOpenDailyPremium : config.activityOpenDailyFree;
}
