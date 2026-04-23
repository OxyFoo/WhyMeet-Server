import { getRedis, isRedisAvailable } from '@/services/redisService';
import { env } from '@/config/env';
import { logger } from '@/config/logger';

const KEY_PREFIX = 'discovery:counts:';

function key(userId: string): string {
    return `${KEY_PREFIX}${userId}`;
}

/**
 * Cache aggregated "count per intention" for a user.
 * Invalidated on any action that changes discovery filters or the exclude set
 * (update-preferences, like, skip, star, decline-request, accept-request).
 * TTL also fenced by REDIS_TTL_SETUP_S as a safety net.
 */
export async function getDiscoveryCounts(userId: string): Promise<Record<string, number> | null> {
    if (!isRedisAvailable()) return null;

    try {
        const raw = await getRedis().get(key(userId));
        if (!raw) return null;
        return JSON.parse(raw) as Record<string, number>;
    } catch (error) {
        logger.warn('[DiscoveryCountsCache] Redis error on get', error);
        return null;
    }
}

export async function setDiscoveryCounts(userId: string, counts: Record<string, number>): Promise<void> {
    if (!isRedisAvailable()) return;

    try {
        await getRedis().set(key(userId), JSON.stringify(counts), 'EX', env.REDIS_TTL_SETUP_S);
    } catch (error) {
        logger.warn('[DiscoveryCountsCache] Redis error on set', error);
    }
}

export async function invalidateDiscoveryCounts(userId: string): Promise<void> {
    if (!isRedisAvailable()) return;

    try {
        await getRedis().del(key(userId));
        logger.debug(`[DiscoveryCountsCache] Invalidated counts for user ${userId}`);
    } catch (error) {
        logger.warn('[DiscoveryCountsCache] Redis error on invalidate', error);
    }
}
