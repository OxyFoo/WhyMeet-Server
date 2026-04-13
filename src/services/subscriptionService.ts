import { getDatabase } from '@/services/database';
import type { UserSubscription, SubscriptionPlatform, SubscriptionPlan } from '@whymeet/types';
import { grantSubscriptionBoost } from '@/services/boostService';
import { logger } from '@/config/logger';

/**
 * Check if a user currently has an active premium subscription.
 */
export async function isPremium(userId: string): Promise<boolean> {
    const db = getDatabase();
    const sub = await db.subscription.findUnique({ where: { userId } });
    if (!sub) return false;
    return sub.status === 'active' && sub.expiresAt > new Date();
}

/**
 * Get the user's subscription info (or null if none).
 */
export async function getSubscription(userId: string): Promise<UserSubscription | null> {
    const db = getDatabase();
    const sub = await db.subscription.findUnique({ where: { userId } });
    if (!sub) return null;

    // Auto-expire if past date
    if (sub.status === 'active' && sub.expiresAt <= new Date()) {
        await db.subscription.update({
            where: { userId },
            data: { status: 'expired' }
        });
        return {
            plan: sub.plan as SubscriptionPlan,
            status: 'expired',
            expiresAt: sub.expiresAt.toISOString(),
            platform: sub.platform as SubscriptionPlatform
        };
    }

    return {
        plan: sub.plan as SubscriptionPlan,
        status: sub.status as UserSubscription['status'],
        expiresAt: sub.expiresAt.toISOString(),
        platform: sub.platform as SubscriptionPlatform
    };
}

/**
 * Validate a receipt from the store and create/update the subscription.
 * For now, this is a stub that trusts the receipt (real validation with Apple/Google APIs to be added).
 * Returns the updated subscription.
 */
export async function validateReceipt(
    userId: string,
    receipt: string,
    platform: SubscriptionPlatform,
    productId: string
): Promise<UserSubscription> {
    const db = getDatabase();

    // TODO: Validate receipt with Apple App Store Server API v2 or Google Play Developer API
    // For now, we trust the receipt and create/update the subscription
    // In production, this MUST validate the receipt server-side before granting access

    const plan = productIdToPlan(productId);
    const expiresAt = computeExpiryDate(plan);

    const sub = await db.subscription.upsert({
        where: { userId },
        update: {
            plan,
            status: 'active',
            platform,
            productId,
            expiresAt,
            originalTransactionId: receipt.slice(0, 64) // store a ref
        },
        create: {
            userId,
            plan,
            status: 'active',
            platform,
            productId,
            expiresAt,
            originalTransactionId: receipt.slice(0, 64)
        }
    });

    // Grant 10-day subscription boost on new subscription or renewal
    try {
        await grantSubscriptionBoost(userId);
    } catch {
        // Boost already active — that's fine
        logger.debug(`[Subscription] Boost already active for user ${userId}, skipping grant`);
    }

    logger.info(`[Subscription] Receipt validated: user=${userId}, plan=${plan}, expires=${expiresAt.toISOString()}`);

    return {
        plan: sub.plan as SubscriptionPlan,
        status: sub.status as UserSubscription['status'],
        expiresAt: sub.expiresAt.toISOString(),
        platform: sub.platform as SubscriptionPlatform
    };
}

function productIdToPlan(productId: string): SubscriptionPlan {
    if (productId.includes('annual')) return 'annual';
    if (productId.includes('semi_annual')) return 'semi_annual';
    return 'monthly';
}

function computeExpiryDate(plan: SubscriptionPlan): Date {
    const now = new Date();
    switch (plan) {
        case 'monthly':
            return new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
        case 'semi_annual':
            return new Date(now.getFullYear(), now.getMonth() + 6, now.getDate());
        case 'annual':
            return new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
    }
}
