import { getDatabase } from '@/services/database';
import { isPremium } from '@/services/subscriptionService';
import { APP_CONFIG_KEYS, type UsageLimitConfig } from '@/config/usageLimitDefaults';

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

function getConfigValue(byKey: Map<string, number>, key: string): number {
    const value = byKey.get(key);
    if (value === undefined) {
        throw new Error(`[UsageLimits] Missing app_config key: ${key}`);
    }
    return value;
}

export async function getUsageLimitConfig(): Promise<UsageLimitConfig> {
    const now = Date.now();
    if (cache && cache.expiresAt > now) return cache.values;

    const db = getDatabase();
    const keys = Object.values(APP_CONFIG_KEYS) as string[];
    const rows = await db.appConfig.findMany({ where: { key: { in: keys } } });
    const byKey = new Map<string, number>();
    for (const row of rows) {
        if (row.valueInt !== null && row.valueInt !== undefined) byKey.set(row.key, row.valueInt);
    }

    const values: UsageLimitConfig = {
        searchDailyFree: getConfigValue(byKey, APP_CONFIG_KEYS.searchDailyFree),
        searchDailyPremium: getConfigValue(byKey, APP_CONFIG_KEYS.searchDailyPremium),
        swipeDailyFree: getConfigValue(byKey, APP_CONFIG_KEYS.swipeDailyFree),
        swipeDailyPremium: getConfigValue(byKey, APP_CONFIG_KEYS.swipeDailyPremium),
        activityOpenDailyFree: getConfigValue(byKey, APP_CONFIG_KEYS.activityOpenDailyFree),
        activityOpenDailyPremium: getConfigValue(byKey, APP_CONFIG_KEYS.activityOpenDailyPremium),
        initialSearchTokens: getConfigValue(byKey, APP_CONFIG_KEYS.initialSearchTokens),
        subscriptionBoostDays: getConfigValue(byKey, APP_CONFIG_KEYS.subscriptionBoostDays),
        subscriptionGracePeriodDays: getConfigValue(byKey, APP_CONFIG_KEYS.subscriptionGracePeriodDays)
    };

    cache = { values, expiresAt: now + CACHE_TTL_MS };
    return values;
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
