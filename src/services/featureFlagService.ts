import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

const CACHE_TTL_MS = 10_000;

type CacheEntry = { value: boolean; expiresAt: number };
const cache = new Map<string, CacheEntry>();

/** Default values used when the flag has never been written to DB. */
const DEFAULTS: Record<string, boolean> = {
    mapbox: true
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
