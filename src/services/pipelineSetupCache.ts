import { getRedis, isRedisAvailable } from '@/services/redisService';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import type { PipelineSetup } from '@/services/discoveryPipeline';

const KEY_PREFIX = 'pipeline:setup:';

function key(userId: string): string {
    return `${KEY_PREFIX}${userId}`;
}

// Set<string> is not JSON-serializable — store as array
type SerializedSetup = Omit<PipelineSetup, 'myTagLabels'> & { myTagLabels: string[] };

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Retrieve cached PipelineSetup for a user.
 * Note: excludeIds is always returned as [] — callers must merge with getExcludeIds().
 */
export async function getPipelineSetup(userId: string): Promise<PipelineSetup | null> {
    if (!isRedisAvailable()) return null;

    try {
        const raw = await getRedis().get(key(userId));
        if (!raw) return null;

        const data = JSON.parse(raw) as SerializedSetup;
        return { ...data, myTagLabels: new Set(data.myTagLabels) };
    } catch (error) {
        logger.warn('[PipelineSetupCache] Redis error on get', error);
        return null;
    }
}

/**
 * Store a PipelineSetup in cache.
 * Pass setup with excludeIds: [] — they are never stored here (live in Redis Set).
 */
export async function setPipelineSetup(userId: string, setup: PipelineSetup): Promise<void> {
    if (!isRedisAvailable()) return;

    try {
        const serialized: SerializedSetup = {
            ...setup,
            myTagLabels: [...setup.myTagLabels]
        };
        await getRedis().set(key(userId), JSON.stringify(serialized), 'EX', env.REDIS_TTL_SETUP_S);
    } catch (error) {
        logger.warn('[PipelineSetupCache] Redis error on set', error);
    }
}

/**
 * Invalidate the setup cache for a user.
 * Call when profile data or discovery preferences change.
 */
export async function invalidatePipelineSetup(userId: string): Promise<void> {
    if (!isRedisAvailable()) return;

    try {
        await getRedis().del(key(userId));
        logger.debug(`[PipelineSetupCache] Invalidated setup for user ${userId}`);
    } catch (error) {
        logger.warn('[PipelineSetupCache] Redis error on invalidate', error);
    }
}
