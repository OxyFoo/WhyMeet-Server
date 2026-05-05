import { getDatabase } from '@/services/database';
import type { ActivityQuotaInfo } from '@oxyfoo/whymeet-types';
import { isPremium } from '@/services/subscriptionService';
import { getUsageLimitConfig } from '@/services/usageLimitsService';

function nextMidnight(): Date {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(0, 0, 0, 0);
    return d;
}

async function getDailyLimit(userId: string): Promise<number> {
    const [premium, config] = await Promise.all([isPremium(userId), getUsageLimitConfig()]);
    return premium ? config.activityOpenDailyPremium : config.activityOpenDailyFree;
}

export async function getActivityQuota(userId: string): Promise<ActivityQuotaInfo> {
    const db = getDatabase();
    const dailyLimit = await getDailyLimit(userId);

    if (dailyLimit === -1) {
        return { remaining: -1, dailyLimit: -1 };
    }

    let record = await db.activityQuota.findUnique({ where: { userId } });

    if (!record) {
        record = await db.activityQuota.create({
            data: { userId, remaining: dailyLimit, resetAt: nextMidnight() }
        });
    }

    if (record.resetAt <= new Date()) {
        record = await db.activityQuota.update({
            where: { userId },
            data: { remaining: dailyLimit, resetAt: nextMidnight() }
        });
    }

    // Apply runtime config changes that lower the daily cap.
    if (record.remaining > dailyLimit) {
        record = await db.activityQuota.update({
            where: { userId },
            data: { remaining: dailyLimit }
        });
    }

    return { remaining: Math.max(0, record.remaining), dailyLimit };
}

export async function useActivityQuota(userId: string): Promise<ActivityQuotaInfo> {
    const quota = await getActivityQuota(userId);

    if (quota.dailyLimit === -1) {
        return quota;
    }

    if (quota.remaining <= 0) {
        throw new Error('activity_quota_exceeded');
    }

    const db = getDatabase();
    const record = await db.activityQuota.update({
        where: { userId },
        data: { remaining: { decrement: 1 } }
    });

    return {
        remaining: Math.max(0, record.remaining),
        dailyLimit: quota.dailyLimit
    };
}
