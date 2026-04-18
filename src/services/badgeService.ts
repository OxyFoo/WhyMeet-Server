import { BADGE_DEFINITIONS, type BadgeKey, type UserBadge } from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

const ONE_YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

interface BadgeContext {
    userId: string;
    verified: boolean;
    createdAt: Date;
    completedHostedCount: number;
    participationCount: number;
}

async function buildContext(userId: string): Promise<BadgeContext> {
    const db = getDatabase();

    const user = await db.user.findUniqueOrThrow({
        where: { id: userId },
        select: { verified: true, createdAt: true }
    });

    const profile = await db.profile.findUnique({
        where: { userId },
        select: { completedHostedCount: true }
    });

    const participationCount = await db.activityParticipant.count({
        where: { userId, activity: { hostId: { not: userId } } }
    });

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

        default:
            return { progress: 0, earned: false };
    }
}

/**
 * Check all badge conditions for a user and upsert their progress in DB.
 */
export async function checkAndAwardBadges(userId: string): Promise<void> {
    const db = getDatabase();

    try {
        const ctx = await buildContext(userId);

        for (const def of BADGE_DEFINITIONS) {
            const { progress, earned } = evaluateBadge(def.key, ctx);

            const existing = await db.userBadge.findUnique({
                where: { userId_badgeKey: { userId, badgeKey: def.key } }
            });

            if (existing) {
                // Don't downgrade earned badges
                if (existing.earned && !earned) continue;

                if (existing.progress !== progress || existing.earned !== earned) {
                    await db.userBadge.update({
                        where: { userId_badgeKey: { userId, badgeKey: def.key } },
                        data: {
                            progress,
                            earned,
                            earnedAt: earned && !existing.earned ? new Date() : existing.earnedAt
                        }
                    });
                }
            } else {
                await db.userBadge.create({
                    data: {
                        userId,
                        badgeKey: def.key,
                        progress,
                        earned,
                        earnedAt: earned ? new Date() : null
                    }
                });
            }
        }
    } catch (error) {
        logger.error(`[BadgeService] Error checking badges for user ${userId}`, error);
    }
}

/**
 * Get all badges for a user, merging DB state with definitions.
 * Returns all badges (earned and not-earned) sorted by displayOrder.
 */
export async function getUserBadges(userId: string): Promise<UserBadge[]> {
    const db = getDatabase();

    const dbBadges = await db.userBadge.findMany({
        where: { userId }
    });

    const badgeMap = new Map(dbBadges.map((b) => [b.badgeKey, b]));

    return BADGE_DEFINITIONS.map((def) => {
        const db = badgeMap.get(def.key);
        return {
            key: def.key,
            earned: db?.earned ?? false,
            earnedAt: db?.earnedAt?.toISOString() ?? null,
            progress: db?.progress ?? 0,
            threshold: def.threshold
        };
    }).sort((a, b) => {
        const defA = BADGE_DEFINITIONS.find((d) => d.key === a.key)!;
        const defB = BADGE_DEFINITIONS.find((d) => d.key === b.key)!;
        // Earned first, then by displayOrder
        if (a.earned !== b.earned) return a.earned ? -1 : 1;
        return defA.displayOrder - defB.displayOrder;
    });
}

/**
 * Get top N earned badges for a user, sorted by displayOrder ascending.
 */
export async function getTopBadges(userId: string, limit: number = 3): Promise<UserBadge[]> {
    const db = getDatabase();

    const dbBadges = await db.userBadge.findMany({
        where: { userId, earned: true }
    });

    // Sort by displayOrder ascending (most important first)
    const sorted = dbBadges
        .map((b) => {
            const def = BADGE_DEFINITIONS.find((d) => d.key === b.badgeKey);
            return { badge: b, order: def?.displayOrder ?? 999 };
        })
        .sort((a, b) => a.order - b.order)
        .slice(0, limit);

    return sorted.map(({ badge }) => {
        const def = BADGE_DEFINITIONS.find((d) => d.key === badge.badgeKey);
        return {
            key: badge.badgeKey as BadgeKey,
            earned: true,
            earnedAt: badge.earnedAt?.toISOString() ?? null,
            progress: badge.progress,
            threshold: def?.threshold ?? null
        };
    });
}
