import { getDatabase } from '@/services/database';
import { isPremium } from '@/services/subscriptionService';
import { getUsageLimitConfig } from '@/services/usageLimitsService';

export interface ActivityViewQuotaInfo {
    activityViewsRemaining: number;
    dailyActivityOpenLimit: number;
}

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

export async function getActivityViewQuota(userId: string): Promise<ActivityViewQuotaInfo> {
    const db = getDatabase();
    const limit = await getDailyLimit(userId);

    if (limit === -1) {
        return { activityViewsRemaining: -1, dailyActivityOpenLimit: -1 };
    }

    let record = await db.activityViewQuota.findUnique({ where: { userId } });

    if (!record) {
        record = await db.activityViewQuota.create({
            data: {
                userId,
                activityViewsRemaining: limit,
                resetAt: nextMidnight()
            }
        });
    }

    if (record.resetAt <= new Date()) {
        record = await db.activityViewQuota.update({
            where: { userId },
            data: { activityViewsRemaining: limit, resetAt: nextMidnight() }
        });
    }

    // Handle runtime config edits that reduce/increase the daily max.
    if (record.activityViewsRemaining > limit) {
        record = await db.activityViewQuota.update({
            where: { userId },
            data: { activityViewsRemaining: limit }
        });
    }

    return {
        activityViewsRemaining: Math.max(0, record.activityViewsRemaining),
        dailyActivityOpenLimit: limit
    };
}

export async function useActivityView(userId: string): Promise<ActivityViewQuotaInfo> {
    const quota = await getActivityViewQuota(userId);

    if (quota.dailyActivityOpenLimit === -1) {
        return quota;
    }

    if (quota.activityViewsRemaining <= 0) {
        throw new Error('activity_quota_exceeded');
    }

    const db = getDatabase();
    const record = await db.activityViewQuota.update({
        where: { userId },
        data: { activityViewsRemaining: { decrement: 1 } }
    });

    return {
        activityViewsRemaining: Math.max(0, record.activityViewsRemaining),
        dailyActivityOpenLimit: quota.dailyActivityOpenLimit
    };
}
