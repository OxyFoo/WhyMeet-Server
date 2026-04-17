import { getRedis, isRedisAvailable } from '@/services/redisService';
import { env } from '@/config/env';
import { logger } from '@/config/logger';

const KEY_PREFIX = 'candidate:';

// Date fields that must be revived when deserializing from Redis
const DATE_FIELDS = new Set(['birthDate', 'createdAt', 'updatedAt', 'suspendedAt', 'deletedAt', 'timestamp']);

function key(userId: string): string {
    return `${KEY_PREFIX}${userId}`;
}

function revive(_: string, value: unknown): unknown {
    if (typeof value === 'string' && DATE_FIELDS.has(_) && value) {
        const d = new Date(value);
        return isNaN(d.getTime()) ? value : d;
    }
    return value;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Bulk-get cached candidate rows. Returns a Map of id → row for cache hits.
 * Missing IDs are simply absent from the map.
 */
export async function getCandidates(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
    const result = new Map<string, Record<string, unknown>>();
    if (!isRedisAvailable() || ids.length === 0) return result;

    try {
        const redis = getRedis();
        const values = await redis.mget(...ids.map(key));

        for (let i = 0; i < ids.length; i++) {
            const raw = values[i];
            if (raw) {
                try {
                    result.set(ids[i], JSON.parse(raw, revive) as Record<string, unknown>);
                } catch {
                    // Corrupted entry — skip, will be re-fetched from DB
                }
            }
        }
    } catch (error) {
        logger.warn('[CandidateCache] Redis error on get', error);
    }

    return result;
}

/**
 * Store candidate rows in Redis. Uses a pipeline for bulk writes.
 */
export async function setCandidates(users: Record<string, unknown>[]): Promise<void> {
    if (!isRedisAvailable() || users.length === 0) return;

    try {
        const redis = getRedis();
        const ttl = env.REDIS_TTL_CANDIDATE_S;
        const pipeline = redis.pipeline();

        for (const user of users) {
            if (typeof user.id === 'string') {
                pipeline.set(key(user.id), JSON.stringify(user), 'EX', ttl);
            }
        }

        await pipeline.exec();
    } catch (error) {
        logger.warn('[CandidateCache] Redis error on set', error);
    }
}

/**
 * Invalidate a single user's cached candidate entry.
 * Call on profile update, photo upload/delete/reorder.
 */
export async function invalidateCandidate(userId: string): Promise<void> {
    if (!isRedisAvailable()) return;

    try {
        await getRedis().del(key(userId));
        logger.debug(`[CandidateCache] Invalidated candidate ${userId}`);
    } catch (error) {
        logger.warn('[CandidateCache] Redis error on invalidate', error);
    }
}
