import { getRedis, isRedisAvailable } from '@/services/redisService';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

const KEY_PREFIX = 'excluded:';
const TTL_SECONDS = 86400; // 24 h — refreshed on next discovery seed

function key(userId: string): string {
    return `${KEY_PREFIX}${userId}`;
}

// ─── Seed from DB ────────────────────────────────────────────────────────────

async function seedExcludeSet(userId: string): Promise<string[]> {
    const db = getDatabase();
    const [seenMatches, blocks, reports] = await Promise.all([
        db.match.findMany({ where: { senderId: userId }, select: { receiverId: true } }),
        db.block.findMany({
            where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
            select: { blockerId: true, blockedId: true }
        }),
        db.report.findMany({ where: { reporterId: userId }, select: { reportedId: true } })
    ]);

    const seenIds = seenMatches.map((m) => m.receiverId);
    const blockedIds = blocks.map((b) => (b.blockerId === userId ? b.blockedId : b.blockerId));
    const reportedIds = reports.map((r) => r.reportedId);
    const allIds = [...new Set([...seenIds, ...blockedIds, ...reportedIds])];

    if (allIds.length > 0) {
        const redis = getRedis();
        await redis.sadd(key(userId), ...allIds);
    }
    // Always set TTL (even on empty set, so we know it was seeded)
    await getRedis().set(`${KEY_PREFIX}seeded:${userId}`, '1', 'EX', TTL_SECONDS);

    logger.debug(`[ExcludeCache] Seeded ${allIds.length} IDs for user ${userId}`);
    return allIds;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the full exclusion list for a user (self + seen + blocked + reported).
 * Seeds from DB on first call. Subsequent calls hit Redis only.
 */
export async function getExcludeIds(userId: string): Promise<string[]> {
    if (!isRedisAvailable()) {
        return fallbackFromDb(userId);
    }

    try {
        const redis = getRedis();
        const seeded = await redis.exists(`${KEY_PREFIX}seeded:${userId}`);
        if (!seeded) {
            const ids = await seedExcludeSet(userId);
            return [userId, ...ids];
        }
        const members = await redis.smembers(key(userId));
        return [userId, ...members];
    } catch (error) {
        logger.warn('[ExcludeCache] Redis error, falling back to DB', error);
        return fallbackFromDb(userId);
    }
}

/**
 * Adds a single targetId to the requester's exclusion set.
 * No-op if the set hasn't been seeded yet (will be populated on next getExcludeIds call).
 */
export async function addExcluded(userId: string, targetId: string): Promise<void> {
    if (!isRedisAvailable()) return;

    try {
        const redis = getRedis();
        const seeded = await redis.exists(`${KEY_PREFIX}seeded:${userId}`);
        if (seeded) {
            await redis.sadd(key(userId), targetId);
        }
    } catch (error) {
        logger.warn('[ExcludeCache] Failed to add excluded id', error);
    }
}

// ─── Fallback (Redis unavailable) ────────────────────────────────────────────

async function fallbackFromDb(userId: string): Promise<string[]> {
    const db = getDatabase();
    const [seenMatches, blocks, reports] = await Promise.all([
        db.match.findMany({ where: { senderId: userId }, select: { receiverId: true } }),
        db.block.findMany({
            where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
            select: { blockerId: true, blockedId: true }
        }),
        db.report.findMany({ where: { reporterId: userId }, select: { reportedId: true } })
    ]);

    const seenIds = seenMatches.map((m) => m.receiverId);
    const blockedIds = blocks.map((b) => (b.blockerId === userId ? b.blockedId : b.blockerId));
    const reportedIds = reports.map((r) => r.reportedId);
    return [...new Set([userId, ...seenIds, ...blockedIds, ...reportedIds])];
}
