import { getDatabase } from '@/services/database';
import type { ActivityQuotaInfo } from '@oxyfoo/whymeet-types';
import { getActivityOpenDailyLimit } from '@/services/usageLimitsService';

function nextMidnight(): Date {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(0, 0, 0, 0);
    return d;
}

async function getDailyLimit(userId: string): Promise<number> {
    return getActivityOpenDailyLimit(userId);
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

function today(): Date {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d;
}

// Debits the activity quota only the FIRST time a user opens a given activity
// in a day. Subsequent reads of the same activity (e.g. refetches after a
// React-Query invalidation) return the current quota without re-debiting.
export async function useActivityQuotaOnFirstOpen(userId: string, activityId: string): Promise<ActivityQuotaInfo> {
    const db = getDatabase();

    try {
        await db.activityOpen.create({
            data: { userId, activityId, day: today() }
        });
    } catch (err) {
        // Unique constraint (userId, activityId, day) → already opened today.
        if (err instanceof Error && /Unique constraint|P2002/i.test(err.message)) {
            return getActivityQuota(userId);
        }
        throw err;
    }

    return useActivityQuota(userId);
}
