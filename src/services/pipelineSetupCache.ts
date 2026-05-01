import { getRedis, isRedisAvailable } from '@/services/redisService';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import type { PipelineSetup } from '@/services/discoveryPipeline';
import type { InterestCategoryKey } from '@oxyfoo/whymeet-types';

const KEY_PREFIX = 'pipeline:setup:';
// Bump this when the serialized shape changes so that in-flight Redis entries
// are ignored (rather than deserialised with a stale shape).
const CACHE_VERSION = 4;

function key(userId: string): string {
    return `${KEY_PREFIX}v${CACHE_VERSION}:${userId}`;
}

// Set<>/Map<> are not JSON-serializable — store as arrays
type SerializedSetup = Omit<PipelineSetup, 'myInterestLabels' | 'mySkillLabels' | 'myDomainCounts'> & {
    myInterestLabels: string[];
    mySkillLabels: string[];
    myDomainCounts: Array<[InterestCategoryKey, number]>;
};

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
        return {
            ...data,
            myInterestLabels: new Set(data.myInterestLabels),
            mySkillLabels: new Set(data.mySkillLabels),
            myDomainCounts: new Map(data.myDomainCounts)
        };
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
            myInterestLabels: [...setup.myInterestLabels],
            mySkillLabels: [...setup.mySkillLabels],
            myDomainCounts: [...setup.myDomainCounts]
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

/**
 * Invalidate the setup cache for ALL users. Used when a global flag that
 * affects every cached setup changes (e.g. stresstest.bot_user_mixing) so the
 * next discovery query rebuilds with the new flag value.
 */
export async function invalidateAllPipelineSetup(): Promise<number> {
    if (!isRedisAvailable()) return 0;

    try {
        const redis = getRedis();
        const pattern = `${KEY_PREFIX}v${CACHE_VERSION}:*`;
        let cursor = '0';
        let total = 0;
        do {
            const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
            cursor = next;
            if (keys.length > 0) {
                await redis.del(...keys);
                total += keys.length;
            }
        } while (cursor !== '0');
        logger.debug(`[PipelineSetupCache] Invalidated ${total} setup entries`);
        return total;
    } catch (error) {
        logger.warn('[PipelineSetupCache] Redis error on invalidateAll', error);
        return 0;
    }
}
