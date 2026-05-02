import { getDatabase } from '@/services/database';
import type { TokenBalance } from '@oxyfoo/whymeet-types';
import { isPremium } from '@/services/subscriptionService';
import { logger } from '@/config/logger';
import { getUsageLimitConfig } from '@/services/usageLimitsService';

/**
 * Get the start of today (midnight UTC).
 */
function todayMidnight(): Date {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d;
}

/**
 * Get (and auto-refill) user's token balance.
 * - If no record exists, creates one with INITIAL_TOKEN_COUNT.
 * - If lastRefillAt < today's midnight → refill to free(3) or premium(20) if below cap.
 */
export async function getBalance(userId: string): Promise<TokenBalance> {
    const db = getDatabase();
    const config = await getUsageLimitConfig();
    let record = await db.tokenBalance.findUnique({ where: { userId } });

    if (!record) {
        const premium = await isPremium(userId);
        const initialTokens = premium ? config.searchDailyPremium : config.initialSearchTokens;
        record = await db.tokenBalance.create({
            data: { userId, tokens: initialTokens, lastRefillAt: new Date() }
        });
        return { tokens: record.tokens, lastRefillAt: record.lastRefillAt.toISOString() };
    }

    const midnight = todayMidnight();
    if (record.lastRefillAt < midnight) {
        const premium = await isPremium(userId);
        const cap = premium ? config.searchDailyPremium : config.searchDailyFree;

        const newTokens = Math.max(record.tokens, cap);
        record = await db.tokenBalance.update({
            where: { userId },
            data: { tokens: newTokens, lastRefillAt: new Date() }
        });
        logger.debug(`[Tokens] Refilled user=${userId}, tokens=${newTokens} (premium=${premium})`);
    }

    return { tokens: record.tokens, lastRefillAt: record.lastRefillAt.toISOString() };
}

/**
 * Use 1 token. Returns new balance. Throws if tokens === 0.
 */
export async function useToken(userId: string): Promise<TokenBalance> {
    // Ensure refill is applied first
    const balance = await getBalance(userId);
    if (balance.tokens <= 0) {
        throw new Error('no_tokens');
    }

    const db = getDatabase();
    const record = await db.tokenBalance.update({
        where: { userId },
        data: { tokens: { decrement: 1 } }
    });

    return { tokens: record.tokens, lastRefillAt: record.lastRefillAt.toISOString() };
}

/**
 * Add tokens to a user's balance. Used for IAP purchases.
 */
export async function addTokens(userId: string, count: number): Promise<TokenBalance> {
    const db = getDatabase();
    const config = await getUsageLimitConfig();
    let record = await db.tokenBalance.findUnique({ where: { userId } });

    if (!record) {
        record = await db.tokenBalance.create({
            data: { userId, tokens: config.initialSearchTokens + count, lastRefillAt: new Date() }
        });
    } else {
        record = await db.tokenBalance.update({
            where: { userId },
            data: { tokens: { increment: count } }
        });
    }

    return { tokens: record.tokens, lastRefillAt: record.lastRefillAt.toISOString() };
}
