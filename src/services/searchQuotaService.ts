import { getDatabase } from '@/services/database';
import type { SearchQuotaInfo } from '@oxyfoo/whymeet-types';
import { logger } from '@/config/logger';
import { getSearchQuotaLimits } from '@/services/usageLimitsService';

/**
 * Next midnight UTC — used as the reset instant for the daily quota window.
 */
function nextMidnight(): Date {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(0, 0, 0, 0);
    return d;
}

/**
 * Get (and auto-refill) the user's search quota.
 *
 * Unlike pure swipe/activity quotas, the search "remaining" can grow beyond
 * the daily cap thanks to in-app purchases (`addSearchTokens`). On reset we
 * therefore keep `Math.max(record.remaining, dailyLimit)` so users don't lose
 * tokens they bought.
 */
export async function getSearchQuota(userId: string): Promise<SearchQuotaInfo> {
    const db = getDatabase();
    const { dailyLimit, initialRemaining } = await getSearchQuotaLimits(userId);

    if (dailyLimit === -1) {
        return { remaining: -1, dailyLimit: -1 };
    }

    let record = await db.searchQuota.findUnique({ where: { userId } });

    if (!record) {
        record = await db.searchQuota.create({
            data: { userId, remaining: initialRemaining, resetAt: nextMidnight() }
        });
        return { remaining: record.remaining, dailyLimit };
    }

    if (record.resetAt <= new Date()) {
        const newRemaining = Math.max(record.remaining, dailyLimit);
        record = await db.searchQuota.update({
            where: { userId },
            data: { remaining: newRemaining, resetAt: nextMidnight() }
        });
        logger.debug(`[Search] Refilled user=${userId} remaining=${newRemaining} dailyLimit=${dailyLimit}`);
    }

    return { remaining: record.remaining, dailyLimit };
}

/**
 * Consume one search token. Throws if the quota is empty.
 */
export async function useSearchQuota(userId: string): Promise<SearchQuotaInfo> {
    const quota = await getSearchQuota(userId);
    if (quota.dailyLimit === -1) {
        return quota;
    }

    if (quota.remaining <= 0) {
        throw new Error('no_tokens');
    }

    const db = getDatabase();
    const record = await db.searchQuota.update({
        where: { userId },
        data: { remaining: { decrement: 1 } }
    });

    return { remaining: Math.max(0, record.remaining), dailyLimit: quota.dailyLimit };
}

/**
 * Add tokens to a user's search quota (IAP purchases).
 * The bought tokens carry over across daily resets.
 */
export async function addSearchTokens(userId: string, count: number): Promise<SearchQuotaInfo> {
    const db = getDatabase();
    const quota = await getSearchQuota(userId);
    if (quota.dailyLimit === -1) {
        return quota;
    }

    const record = await db.searchQuota.update({
        where: { userId },
        data: { remaining: { increment: count } }
    });

    return { remaining: record.remaining, dailyLimit: quota.dailyLimit };
}
