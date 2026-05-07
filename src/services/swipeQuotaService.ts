import { getDatabase } from '@/services/database';
import type { SwipeQuotaInfo } from '@oxyfoo/whymeet-types';
import { getSwipeDailyLimit } from '@/services/usageLimitsService';

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
 * Get the current swipe quota for a user (auto-reset if past midnight UTC).
 */
export async function getSwipeQuota(userId: string): Promise<SwipeQuotaInfo> {
    const db = getDatabase();
    const dailyLimit = await getSwipeDailyLimit(userId);

    if (dailyLimit === -1) {
        return { remaining: -1, dailyLimit: -1 };
    }

    let record = await db.swipeQuota.findUnique({ where: { userId } });

    if (!record) {
        record = await db.swipeQuota.create({
            data: { userId, remaining: dailyLimit, resetAt: nextMidnight() }
        });
    }

    if (record.resetAt <= new Date()) {
        record = await db.swipeQuota.update({
            where: { userId },
            data: { remaining: dailyLimit, resetAt: nextMidnight() }
        });
    }

    // Apply runtime config changes even before the next reset.
    if (record.remaining > dailyLimit) {
        record = await db.swipeQuota.update({
            where: { userId },
            data: { remaining: dailyLimit }
        });
    }

    return { remaining: Math.max(0, record.remaining), dailyLimit };
}

/**
 * Check if the user can still swipe.
 */
export async function canSwipe(userId: string): Promise<boolean> {
    const quota = await getSwipeQuota(userId);
    return quota.dailyLimit === -1 || quota.remaining > 0;
}

/**
 * Use one swipe. Returns updated quota. Throws if quota exceeded.
 */
export async function useSwipeQuota(userId: string): Promise<SwipeQuotaInfo> {
    const quota = await getSwipeQuota(userId);

    if (quota.dailyLimit === -1) {
        return quota;
    }

    if (quota.remaining <= 0) {
        throw new Error('quota_exceeded');
    }

    const db = getDatabase();
    const record = await db.swipeQuota.update({
        where: { userId },
        data: { remaining: { decrement: 1 } }
    });

    return {
        remaining: Math.max(0, record.remaining),
        dailyLimit: quota.dailyLimit
    };
}
