import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

const CACHE_TTL_MS = 10_000;

type CacheEntry = { value: boolean; expiresAt: number };
const cache = new Map<string, CacheEntry>();

/** Default values used when the flag has never been written to DB. */
const DEFAULTS: Record<string, boolean> = {
    mapbox: true,
    // Safe stresstest mode: when ON, only real accounts present in
    // bot_isolation_bypass_users can see synthetic bot accounts. Every other
    // real user keeps strict isolation.
    'stresstest.bot_user_mixing': false,
    // Dangerous stresstest mode: when ON, synthetic bots and all real users
    // are no longer isolated across discovery surfaces. Keep OFF in prod
    // except for short, explicit operational tests.
    'stresstest.bot_user_mixing_global': false,
    // Emergency kill-switch for Firebase push notifications. When ON,
    // pushToUser() and broadcastPush() short-circuit before any FCM call.
    // Does NOT touch in-app notifications (DB rows, WS delivery).
    'notifications.disabled': false,
    // Master switch for in-app advertising. When OFF, the mobile client
    // never preloads or shows interstitials, regardless of premium status
    // or configured ad unit IDs. Useful for emergency cuts (bad ad unit,
    // policy review, etc.).
    'ads.enabled': true
};

export type FeatureFlagKey = keyof typeof DEFAULTS;

function defaultFor(key: string): boolean {
    return DEFAULTS[key] ?? true;
}

export async function isFeatureEnabled(key: FeatureFlagKey): Promise<boolean> {
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;

    try {
        const db = getDatabase();
        const row = await db.featureFlag.findUnique({ where: { key } });
        const value = row ? row.enabled : defaultFor(key);
        cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
        return value;
    } catch (err) {
        logger.warn(`[FeatureFlag] read failed for "${key}", falling back to default`, err);
        return cached?.value ?? defaultFor(key);
    }
}

export async function setFeatureEnabled(key: FeatureFlagKey, enabled: boolean): Promise<void> {
    const db = getDatabase();
    await db.featureFlag.upsert({
        where: { key },
        update: { enabled },
        create: { key, enabled }
    });
    cache.set(key, { value: enabled, expiresAt: Date.now() + CACHE_TTL_MS });
}

export async function listFeatureFlags(): Promise<Array<{ key: string; enabled: boolean; updatedAt: Date | null }>> {
    const db = getDatabase();
    const rows = await db.featureFlag.findMany();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return Object.keys(DEFAULTS).map((key) => {
        const row = byKey.get(key);
        return {
            key,
            enabled: row ? row.enabled : defaultFor(key),
            updatedAt: row ? row.updatedAt : null
        };
    });
}
