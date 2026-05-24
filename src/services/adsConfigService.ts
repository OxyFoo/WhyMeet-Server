import { APP_CONFIG_KEYS, type AdsRuntimeConfig } from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { isFeatureEnabled } from '@/services/featureFlagService';

const CACHE_TTL_MS = 10_000;

const DEFAULT_SWIPE_FREQUENCY = 10;

type CachedConfig = {
    expiresAt: number;
    value: AdsRuntimeConfig;
};

let cache: CachedConfig | null = null;

const STRING_KEYS = [APP_CONFIG_KEYS.adsInterstitialAndroidUnitId, APP_CONFIG_KEYS.adsInterstitialIosUnitId];
const INT_KEYS = [APP_CONFIG_KEYS.adsInterstitialSwipeFrequency];

export async function getAdsConfig(): Promise<AdsRuntimeConfig> {
    const now = Date.now();
    if (cache && cache.expiresAt > now) return cache.value;

    const db = getDatabase();
    const [enabled, rows] = await Promise.all([
        isFeatureEnabled('ads.enabled'),
        db.appConfig.findMany({ where: { key: { in: [...STRING_KEYS, ...INT_KEYS] } } })
    ]);

    const strings = new Map<string, string>();
    const ints = new Map<string, number>();
    for (const row of rows) {
        if (row.valueString !== null && row.valueString !== undefined) strings.set(row.key, row.valueString);
        if (row.valueInt !== null && row.valueInt !== undefined) ints.set(row.key, row.valueInt);
    }

    const value: AdsRuntimeConfig = {
        enabled,
        androidInterstitialUnitId: strings.get(APP_CONFIG_KEYS.adsInterstitialAndroidUnitId) ?? '',
        iosInterstitialUnitId: strings.get(APP_CONFIG_KEYS.adsInterstitialIosUnitId) ?? '',
        swipeFrequency: ints.get(APP_CONFIG_KEYS.adsInterstitialSwipeFrequency) ?? DEFAULT_SWIPE_FREQUENCY
    };

    cache = { value, expiresAt: now + CACHE_TTL_MS };
    return value;
}

export function invalidateAdsConfigCache(): void {
    cache = null;
}
