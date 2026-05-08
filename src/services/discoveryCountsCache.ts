import { getRedis, isRedisAvailable } from '@/services/redisService';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import type { IntentionKey } from '@oxyfoo/whymeet-types';

const KEY_PREFIX = 'discovery:counts:v2:';
const CANDIDATE_PREFIX = `${KEY_PREFIX}candidate:`;
const SUB_INTENTION_PREFIX = `${KEY_PREFIX}sub:`;
const inFlight = new Map<string, Promise<unknown>>();

function candidateKey(userId: string): string {
    return `${CANDIDATE_PREFIX}${userId}`;
}

function subIntentionKey(userId: string, intention: IntentionKey): string {
    return `${SUB_INTENTION_PREFIX}${userId}:${intention}`;
}

async function getJson<T>(key: string): Promise<T | null> {
    if (!isRedisAvailable()) return null;

    try {
        const raw = await getRedis().get(key);
        if (!raw) return null;
        return JSON.parse(raw) as T;
    } catch (error) {
        logger.warn('[DiscoveryCountsCache] Redis error on get', error);
        return null;
    }
}

async function setJson(key: string, value: Record<string, number>): Promise<void> {
    if (!isRedisAvailable()) return;

    try {
        await getRedis().set(key, JSON.stringify(value), 'EX', env.REDIS_TTL_DISCOVERY_COUNTS_S);
    } catch (error) {
        logger.warn('[DiscoveryCountsCache] Redis error on set', error);
    }
}

async function scanKeys(pattern: string): Promise<string[]> {
    if (!isRedisAvailable()) return [];

    const redis = getRedis();
    const keys: string[] = [];
    let cursor = '0';
    do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 50);
        cursor = next;
        keys.push(...batch);
    } while (cursor !== '0');
    return keys;
}

async function coalesce<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const pending = inFlight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const promise = compute().finally(() => {
        inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
}

/**
 * Cache aggregated "count per intention" for a user. Swipe actions keep the
 * exclusion set exact but let these UI counters expire naturally, which avoids
 * stampeding seven expensive pipelines during load bursts.
 */
export async function getOrComputeDiscoveryCounts(
    userId: string,
    compute: () => Promise<Record<string, number>>
): Promise<Record<string, number>> {
    const key = candidateKey(userId);
    const cached = await getJson<Record<string, number>>(key);
    if (cached) return cached;

    return coalesce(key, async () => {
        const rechecked = await getJson<Record<string, number>>(key);
        if (rechecked) return rechecked;
        const counts = await compute();
        await setJson(key, counts);
        return counts;
    });
}

export async function getOrComputeSubIntentionCounts(
    userId: string,
    intention: IntentionKey,
    compute: () => Promise<Record<string, number>>
): Promise<Record<string, number>> {
    const key = subIntentionKey(userId, intention);
    const cached = await getJson<Record<string, number>>(key);
    if (cached) return cached;

    return coalesce(key, async () => {
        const rechecked = await getJson<Record<string, number>>(key);
        if (rechecked) return rechecked;
        const counts = await compute();
        await setJson(key, counts);
        return counts;
    });
}

export async function invalidateDiscoveryCounts(userId: string): Promise<void> {
    if (!isRedisAvailable()) return;

    try {
        const subKeys = await scanKeys(`${SUB_INTENTION_PREFIX}${userId}:*`);
        await getRedis().del(candidateKey(userId), ...subKeys);
        logger.debug(`[DiscoveryCountsCache] Invalidated counts for user ${userId}`);
    } catch (error) {
        logger.warn('[DiscoveryCountsCache] Redis error on invalidate', error);
    }
}
