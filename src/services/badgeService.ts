import type { BadgeDefinition, BadgeKey, UserBadge } from '@oxyfoo/whymeet-types';
import type { Prisma, UserBadge as UserBadgeRow } from '@prisma/client';
import { getDatabase } from '@/services/database';
import { getRedis, isRedisAvailable } from '@/services/redisService';
import { sendToUser } from '@/server/connectedClients';
import { BADGE_DEFINITIONS } from '@/reference/badges';
import { logger } from '@/config/logger';

const ONE_YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
const USER_BADGE_CHECK_TTL_S = 60;
const REDIS_BADGE_TTL_KEY = (userId: string) => `badge:check:${userId}`;

// ─── Catalog ────────────────────────────────────────────────────────
// `reference/badges.ts` is the source of truth (re-seeded at boot). The
// console is read-only on the catalog, so the in-memory list is always
// authoritative for the lifetime of the process.

const BADGE_DEFINITIONS_BY_KEY = new Map<BadgeKey, BadgeDefinition>(BADGE_DEFINITIONS.map((d) => [d.key, d]));

const BADGE_KEYS = new Set<BadgeKey>(BADGE_DEFINITIONS.map((d) => d.key));

export async function getBadgeDefinitions(): Promise<readonly BadgeDefinition[]> {
    return BADGE_DEFINITIONS;
}

/**
 * Sort `UserBadge[]` by earned-first then displayOrder, slice to `limit`.
 * Shared between full list and "top N" callers.
 */
export function selectTopBadges(badges: UserBadge[], limit: number): UserBadge[] {
    return [...badges]
        .sort((a, b) => {
            if (a.earned !== b.earned) return a.earned ? -1 : 1;
            return a.displayOrder - b.displayOrder;
        })
        .slice(0, limit);
}

// ─── Context evaluation ─────────────────────────────────────────────

interface BadgeContext {
    userId: string;
    verified: boolean;
    createdAt: Date;
    completedHostedCount: number;
    participationCount: number;
}

async function buildContext(userId: string): Promise<BadgeContext> {
    const db = getDatabase();

    const [user, profile, participationCount] = await Promise.all([
        db.user.findUniqueOrThrow({
            where: { id: userId },
            select: { verified: true, createdAt: true }
        }),
        db.profile.findUnique({
            where: { userId },
            select: { completedHostedCount: true }
        }),
        db.activityParticipant.count({
            where: {
                userId,
                activity: { hostId: { not: userId }, isCompleted: true }
            }
        })
    ]);

    return {
        userId,
        verified: user.verified,
        createdAt: user.createdAt,
        completedHostedCount: profile?.completedHostedCount ?? 0,
        participationCount
    };
}

function evaluateBadge(key: BadgeKey, ctx: BadgeContext): { progress: number; earned: boolean } {
    switch (key) {
        case 'verified_profile':
            return { progress: ctx.verified ? 1 : 0, earned: ctx.verified };

        case 'veteran': {
            const elapsed = Date.now() - ctx.createdAt.getTime();
            return { progress: elapsed >= ONE_YEAR_MS ? 1 : 0, earned: elapsed >= ONE_YEAR_MS };
        }

        case 'first_event_joined':
            return { progress: Math.min(ctx.participationCount, 1), earned: ctx.participationCount >= 1 };

        case 'first_event_hosted':
            return { progress: Math.min(ctx.completedHostedCount, 1), earned: ctx.completedHostedCount >= 1 };

        case 'host_5':
            return { progress: Math.min(ctx.completedHostedCount, 5), earned: ctx.completedHostedCount >= 5 };

        case 'host_10':
            return { progress: Math.min(ctx.completedHostedCount, 10), earned: ctx.completedHostedCount >= 10 };

        case 'host_25':
            return { progress: Math.min(ctx.completedHostedCount, 25), earned: ctx.completedHostedCount >= 25 };

        case 'host_50':
            return { progress: Math.min(ctx.completedHostedCount, 50), earned: ctx.completedHostedCount >= 50 };

        case 'host_100':
            return { progress: Math.min(ctx.completedHostedCount, 100), earned: ctx.completedHostedCount >= 100 };

        case 'participant_10':
            return { progress: Math.min(ctx.participationCount, 10), earned: ctx.participationCount >= 10 };

        case 'participant_50':
            return { progress: Math.min(ctx.participationCount, 50), earned: ctx.participationCount >= 50 };

        default: {
            logger.warn(`[BadgeService] Unknown BadgeKey "${key}" — skipped`);
            return { progress: 0, earned: false };
        }
    }
}

// ─── Mapping ────────────────────────────────────────────────────────

function rowToUserBadge(row: UserBadgeRow, def: BadgeDefinition): UserBadge {
    return {
        key: def.key,
        emoji: def.emoji,
        category: def.category,
        displayOrder: def.displayOrder,
        earned: row.earned,
        earnedAt: row.earnedAt?.toISOString() ?? null,
        progress: row.progress,
        threshold: def.threshold,
        rewardType: def.rewardType,
        rewardDescription: def.rewardDescription,
        rewardClaimedAt: row.rewardClaimedAt?.toISOString() ?? null,
        rewardPendingAt: row.rewardPendingAt?.toISOString() ?? null
    };
}

// ─── Persist ────────────────────────────────────────────────────────

/**
 * Check all badge conditions for a user and upsert their progress in DB.
 * Emits `badge-unlocked` WS events for badges newly earned during this pass.
 */
export async function checkAndAwardBadges(userId: string): Promise<void> {
    await persistBadgeProgress(userId);
}

async function persistBadgeProgress(userId: string): Promise<void> {
    const db = getDatabase();
    const ctx = await buildContext(userId);
    const existingRows = await db.userBadge.findMany({ where: { userId } });
    const existingByKey = new Map(existingRows.map((badge) => [badge.badgeKey, badge]));
    const writes: Prisma.PrismaPromise<unknown>[] = [];
    const newlyUnlocked: BadgeKey[] = [];

    for (const def of BADGE_DEFINITIONS) {
        const { progress, earned } = evaluateBadge(def.key, ctx);
        const existing = existingByKey.get(def.key);
        // Never demote an already-earned badge.
        if (existing?.earned && !earned) continue;

        const earnedAt = earned ? (existing?.earnedAt ?? new Date()) : null;
        const sameEarnedAt = (existing?.earnedAt?.getTime() ?? null) === (earnedAt?.getTime() ?? null);
        if (existing && existing.progress === progress && existing.earned === earned && sameEarnedAt) {
            continue;
        }

        if (earned && !existing?.earned) newlyUnlocked.push(def.key);

        writes.push(
            db.userBadge.upsert({
                where: { userId_badgeKey: { userId, badgeKey: def.key } },
                create: { userId, badgeKey: def.key, progress, earned, earnedAt },
                update: { progress, earned, earnedAt }
            })
        );
    }

    if (writes.length > 0) {
        await db.$transaction(writes);
    }

    if (newlyUnlocked.length > 0) {
        await emitBadgeUnlocked(userId, newlyUnlocked);
    }
}

async function emitBadgeUnlocked(userId: string, keys: BadgeKey[]): Promise<void> {
    try {
        const rows = await getDatabase().userBadge.findMany({
            where: { userId, badgeKey: { in: keys } }
        });
        for (const row of rows) {
            const def = BADGE_DEFINITIONS_BY_KEY.get(row.badgeKey as BadgeKey);
            if (!def) continue;
            sendToUser(userId, {
                event: 'badge-unlocked',
                payload: { badge: rowToUserBadge(row, def) }
            });
        }
    } catch (error) {
        logger.warn('[BadgeService] Failed to emit badge-unlocked', error);
    }
}

// ─── TTL gating (Redis) ─────────────────────────────────────────────

async function shouldRunCheck(userId: string): Promise<boolean> {
    if (!isRedisAvailable()) return true;
    try {
        // SET with NX EX = atomic "claim slot for next N seconds".
        const result = await getRedis().set(REDIS_BADGE_TTL_KEY(userId), '1', 'EX', USER_BADGE_CHECK_TTL_S, 'NX');
        return result === 'OK';
    } catch (error) {
        logger.warn('[BadgeService] Redis TTL check failed, running anyway', error);
        return true;
    }
}

async function clearCheckTtl(userId: string): Promise<void> {
    if (!isRedisAvailable()) return;
    try {
        await getRedis().del(REDIS_BADGE_TTL_KEY(userId));
    } catch {
        // best effort
    }
}

export async function checkAndAwardBadgesIfStale(userId: string): Promise<void> {
    if (!(await shouldRunCheck(userId))) return;
    try {
        await checkAndAwardBadges(userId);
    } catch (error) {
        // Release TTL so the next caller retries instead of silently waiting 60s.
        await clearCheckTtl(userId);
        logger.error(`[BadgeService] Error checking badges for user ${userId}`, error);
        throw error;
    }
}

/**
 * Fire-and-forget badge recheck. Use from caller paths that should not block
 * on (or be broken by) badge evaluation (e.g. join activity, activity completed).
 */
export function triggerBadgeRecheck(userId: string, reason: string): void {
    checkAndAwardBadges(userId).catch((error) =>
        logger.warn(`[BadgeService] background recheck failed (${reason}) for ${userId}`, error)
    );
}

// ─── Read APIs ──────────────────────────────────────────────────────

function isKnownBadgeKey(key: string): key is BadgeKey {
    return BADGE_KEYS.has(key as BadgeKey);
}

/**
 * Get all badges for a user, merging DB state with definitions.
 * Returns all badges (earned and not) sorted by earned-first then displayOrder.
 */
export async function getUserBadges(userId: string): Promise<UserBadge[]> {
    const db = getDatabase();
    const dbBadges = await db.userBadge.findMany({ where: { userId } });
    const badgeRowByKey = new Map(dbBadges.map((b) => [b.badgeKey, b]));

    const result: UserBadge[] = BADGE_DEFINITIONS.map((def) => {
        const row = badgeRowByKey.get(def.key);
        return {
            key: def.key,
            emoji: def.emoji,
            category: def.category,
            displayOrder: def.displayOrder,
            earned: row?.earned ?? false,
            earnedAt: row?.earnedAt?.toISOString() ?? null,
            progress: row?.progress ?? 0,
            threshold: def.threshold,
            rewardType: def.rewardType,
            rewardDescription: def.rewardDescription,
            rewardClaimedAt: row?.rewardClaimedAt?.toISOString() ?? null,
            rewardPendingAt: row?.rewardPendingAt?.toISOString() ?? null
        };
    });

    return selectTopBadges(result, result.length); // earned first + displayOrder
}

/**
 * Get top N earned badges for a user, sorted by displayOrder ascending.
 */
export async function getTopBadges(userId: string, limit: number = 3): Promise<UserBadge[]> {
    const db = getDatabase();
    const dbBadges = await db.userBadge.findMany({
        where: { userId, earned: true }
    });

    const merged: UserBadge[] = dbBadges
        .filter((b) => isKnownBadgeKey(b.badgeKey))
        .map((b) => {
            const def = BADGE_DEFINITIONS_BY_KEY.get(b.badgeKey as BadgeKey)!;
            return rowToUserBadge(b, def);
        });

    return selectTopBadges(merged, limit);
}
