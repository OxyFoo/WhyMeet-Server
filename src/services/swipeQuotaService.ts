import { getDatabase } from '@/services/database';
import type { SwipeQuotaInfo } from '@oxyfoo/whymeet-types';
import { isPremium } from '@/services/subscriptionService';
import { getUsageLimitConfig } from '@/services/usageLimitsService';

/**
 * Get the next midnight UTC for quota reset.
 */
function nextMidnight(): Date {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(0, 0, 0, 0);
    return d;
}

/**
 * Get the current swipe quota for a user (auto-reset if past midnight).
 */
export async function getQuota(userId: string): Promise<SwipeQuotaInfo> {
    const db = getDatabase();
    const [premium, config] = await Promise.all([isPremium(userId), getUsageLimitConfig()]);
    const dailyLimit = premium ? config.swipeDailyPremium : config.swipeDailyFree;

    if (dailyLimit === -1) {
        return { swipesRemaining: -1, dailySwipeLimit: -1 };
    }

    let record = await db.swipeQuota.findUnique({ where: { userId } });

    if (!record) {
        record = await db.swipeQuota.create({
            data: { userId, swipesRemaining: dailyLimit, resetAt: nextMidnight() }
        });
    }

    // Reset if past resetAt
    if (record.resetAt <= new Date()) {
        record = await db.swipeQuota.update({
            where: { userId },
            data: { swipesRemaining: dailyLimit, resetAt: nextMidnight() }
        });
    }

    // Apply runtime config changes even before the next reset.
    if (record.swipesRemaining > dailyLimit) {
        record = await db.swipeQuota.update({
            where: { userId },
            data: { swipesRemaining: dailyLimit }
        });
    }

    return {
        swipesRemaining: Math.max(0, record.swipesRemaining),
        dailySwipeLimit: dailyLimit
    };
}

/**
 * Check if the user can still swipe.
 */
export async function canSwipe(userId: string): Promise<boolean> {
    const quota = await getQuota(userId);
    return quota.dailySwipeLimit === -1 || quota.swipesRemaining > 0;
}

/**
 * Use one swipe. Returns updated quota. Throws if quota exceeded.
 */
export async function useSwipe(userId: string): Promise<SwipeQuotaInfo> {
    const quota = await getQuota(userId);

    // Premium = unlimited
    if (quota.dailySwipeLimit === -1) {
        return quota;
    }

    if (quota.swipesRemaining <= 0) {
        throw new Error('quota_exceeded');
    }

    const db = getDatabase();
    const record = await db.swipeQuota.update({
        where: { userId },
        data: { swipesRemaining: { decrement: 1 } }
    });

    return {
        swipesRemaining: Math.max(0, record.swipesRemaining),
        dailySwipeLimit: quota.dailySwipeLimit
    };
}
