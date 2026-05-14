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

export const APP_CONFIG_KEYS = {
    searchDailyFree: 'counter.search.daily.free',
    searchDailyPremium: 'counter.search.daily.premium',
    swipeDailyFree: 'counter.swipe.daily.free',
    swipeDailyPremium: 'counter.swipe.daily.premium',
    activityOpenDailyFree: 'counter.activity_open.daily.free',
    activityOpenDailyPremium: 'counter.activity_open.daily.premium',
    initialSearchTokens: 'counter.search.initial',
    subscriptionBoostDays: 'subscription.boost.days'
} as const;

export const DEFAULT_USAGE_LIMITS: UsageLimitConfig = {
    searchDailyFree: 3,
    searchDailyPremium: 20,
    swipeDailyFree: 20,
    swipeDailyPremium: -1,
    activityOpenDailyFree: 3,
    activityOpenDailyPremium: 25,
    initialSearchTokens: 5,
    subscriptionBoostDays: 10
};

export const APP_CONFIG_DEFAULT_ROWS = [
    { key: APP_CONFIG_KEYS.searchDailyFree, valueInt: DEFAULT_USAGE_LIMITS.searchDailyFree },
    { key: APP_CONFIG_KEYS.searchDailyPremium, valueInt: DEFAULT_USAGE_LIMITS.searchDailyPremium },
    { key: APP_CONFIG_KEYS.swipeDailyFree, valueInt: DEFAULT_USAGE_LIMITS.swipeDailyFree },
    { key: APP_CONFIG_KEYS.swipeDailyPremium, valueInt: DEFAULT_USAGE_LIMITS.swipeDailyPremium },
    { key: APP_CONFIG_KEYS.activityOpenDailyFree, valueInt: DEFAULT_USAGE_LIMITS.activityOpenDailyFree },
    { key: APP_CONFIG_KEYS.activityOpenDailyPremium, valueInt: DEFAULT_USAGE_LIMITS.activityOpenDailyPremium },
    { key: APP_CONFIG_KEYS.initialSearchTokens, valueInt: DEFAULT_USAGE_LIMITS.initialSearchTokens },
    { key: APP_CONFIG_KEYS.subscriptionBoostDays, valueInt: DEFAULT_USAGE_LIMITS.subscriptionBoostDays }
] as const;
