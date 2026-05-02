import { getDatabase } from '@/services/database';
import type { UserBoost, BoostSource } from '@oxyfoo/whymeet-types';
import { logger } from '@/config/logger';
import { getUsageLimitConfig } from '@/services/usageLimitsService';

/**
 * Check if user has an active boost (not expired).
 */
export async function hasActiveBoost(userId: string): Promise<boolean> {
    const db = getDatabase();
    const boost = await db.activeBoost.findUnique({ where: { userId } });
    if (!boost) return false;
    if (boost.expiresAt <= new Date()) {
        // Clean up expired boost
        await db.activeBoost.delete({ where: { userId } });
        return false;
    }
    return true;
}

/**
 * Get the user's boost status.
 */
export async function getBoostStatus(userId: string): Promise<UserBoost> {
    const db = getDatabase();
    const boost = await db.activeBoost.findUnique({ where: { userId } });
    if (!boost || boost.expiresAt <= new Date()) {
        // Clean up if expired
        if (boost && boost.expiresAt <= new Date()) {
            await db.activeBoost.delete({ where: { userId } });
        }
        return { active: false, expiresAt: null, source: null };
    }
    return {
        active: true,
        expiresAt: boost.expiresAt.toISOString(),
        source: boost.source as BoostSource
    };
}

/**
 * Purchase a boost (1/3/7 days). Fails if already boosted.
 */
export async function purchaseBoost(userId: string, durationDays: number): Promise<UserBoost> {
    const db = getDatabase();

    // Check for existing active boost
    const existing = await db.activeBoost.findUnique({ where: { userId } });
    if (existing && existing.expiresAt > new Date()) {
        throw new Error('already_boosted');
    }

    // Delete expired boost if any, then create new one
    if (existing) {
        await db.activeBoost.delete({ where: { userId } });
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + durationDays);

    const boost = await db.activeBoost.create({
        data: { userId, expiresAt, source: 'purchase' }
    });

    logger.info(`[Boost] Purchased: user=${userId}, days=${durationDays}, expires=${expiresAt.toISOString()}`);

    return {
        active: true,
        expiresAt: boost.expiresAt.toISOString(),
        source: 'purchase'
    };
}

/**
 * Grant a subscription boost (10 days). Fails if already boosted.
 */
export async function grantSubscriptionBoost(userId: string): Promise<UserBoost> {
    const db = getDatabase();
    const { subscriptionBoostDays } = await getUsageLimitConfig();

    const existing = await db.activeBoost.findUnique({ where: { userId } });
    if (existing && existing.expiresAt > new Date()) {
        throw new Error('already_boosted');
    }

    if (existing) {
        await db.activeBoost.delete({ where: { userId } });
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + subscriptionBoostDays);

    const boost = await db.activeBoost.create({
        data: { userId, expiresAt, source: 'subscription' }
    });

    logger.info(`[Boost] Subscription grant: user=${userId}, expires=${expiresAt.toISOString()}`);

    return {
        active: true,
        expiresAt: boost.expiresAt.toISOString(),
        source: 'subscription'
    };
}

/**
 * Get a Set of all currently boosted user IDs. Used by discovery/search for 60/40 interleave.
 */
export async function getBoostedUserIds(): Promise<Set<string>> {
    const db = getDatabase();
    const boosts = await db.activeBoost.findMany({
        where: { expiresAt: { gt: new Date() } },
        select: { userId: true }
    });
    return new Set(boosts.map((b) => b.userId));
}
