import { getDatabase } from '@/services/database';
import { getUsageLimitConfig } from '@/services/usageLimitsService';
import type {
    UserSubscription,
    SubscriptionPlatform,
    SubscriptionPlan,
    PurchaseErrorCode
} from '@oxyfoo/whymeet-types';
import { grantSubscriptionBoost } from '@/services/boostService';
import { logger } from '@/config/logger';
import { validatePurchaseReceipt } from '@/services/receiptValidationService';

async function getGracePeriodDays(): Promise<number> {
    try {
        const config = await getUsageLimitConfig();
        return config.subscriptionGracePeriodDays;
    } catch {
        return 7;
    }
}

export type ValidateReceiptOutcome =
    | { ok: true; subscription: UserSubscription }
    | { ok: false; code: PurchaseErrorCode; reason?: string };

/**
 * Check if a user currently has an active premium subscription.
 * Premium override (admin) wins over the real subscription status.
 */
export async function isPremium(userId: string): Promise<boolean> {
    const db = getDatabase();
    const now = new Date();

    const override = await db.premiumOverride.findUnique({
        where: { userId },
        select: { forcedPremium: true, expiresAt: true }
    });
    if (override && override.expiresAt > now) {
        return override.forcedPremium;
    }

    const sub = await db.subscription.findUnique({ where: { userId } });
    if (!sub) return false;
    return sub.status === 'active' && sub.expiresAt > now;
}

/**
 * Bulk premium lookup. Returns the set of userIds that resolve to premium right now.
 */
export async function getPremiumUserIds(userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const db = getDatabase();
    const now = new Date();

    const [overrides, subs] = await Promise.all([
        db.premiumOverride.findMany({
            where: { userId: { in: userIds }, expiresAt: { gt: now } },
            select: { userId: true, forcedPremium: true }
        }),
        db.subscription.findMany({
            where: { userId: { in: userIds }, status: 'active', expiresAt: { gt: now } },
            select: { userId: true }
        })
    ]);

    const result = new Set<string>();
    const overrideById = new Map(overrides.map((o) => [o.userId, o.forcedPremium]));

    for (const sub of subs) {
        const override = overrideById.get(sub.userId);
        if (override === false) continue;
        result.add(sub.userId);
    }
    for (const [userId, forcedPremium] of overrideById.entries()) {
        if (forcedPremium) result.add(userId);
    }
    return result;
}

/**
 * Get the user's subscription info (or null if none). Handles auto-transition from
 * `active` → `grace_period` → `expired` based on `expiresAt`.
 */
export async function getSubscription(userId: string): Promise<UserSubscription | null> {
    const db = getDatabase();
    const [sub, gracePeriodDays] = await Promise.all([
        db.subscription.findUnique({ where: { userId } }),
        getGracePeriodDays()
    ]);
    if (!sub) return null;

    const now = new Date();
    let status = sub.status as UserSubscription['status'];

    if (sub.status === 'active' && sub.expiresAt <= now) {
        const gracePeriodEnd = new Date(sub.expiresAt.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000);
        const nextStatus: UserSubscription['status'] = now < gracePeriodEnd ? 'grace_period' : 'expired';
        await db.subscription.update({ where: { userId }, data: { status: nextStatus } });
        status = nextStatus;
    } else if (sub.status === 'grace_period') {
        const gracePeriodEnd = new Date(sub.expiresAt.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000);
        if (now >= gracePeriodEnd) {
            await db.subscription.update({ where: { userId }, data: { status: 'expired' } });
            status = 'expired';
        }
    }

    return {
        plan: sub.plan as SubscriptionPlan,
        status,
        expiresAt: sub.expiresAt.toISOString(),
        platform: sub.platform as SubscriptionPlatform,
        cancelledAt: sub.cancelledAt ? sub.cancelledAt.toISOString() : null
    };
}

/**
 * Validate a receipt from the store and create/update the subscription.
 * Returns a structured outcome (never throws on rejected receipts).
 */
export async function validateReceipt(
    userId: string,
    receipt: string,
    platform: SubscriptionPlatform,
    productId: string
): Promise<ValidateReceiptOutcome> {
    const validation = await validatePurchaseReceipt({
        userId,
        receipt,
        platform,
        productId,
        kind: 'subscription'
    });

    if (!validation.ok) {
        logger.warn(
            `[Subscription] Receipt rejected: user=${userId} code=${validation.code} reason=${validation.reason ?? '-'}`
        );
        return { ok: false, code: validation.code, reason: validation.reason };
    }

    const db = getDatabase();
    const plan = productIdToPlan(productId);
    const expiresAt = validation.expiresAtMs
        ? new Date(validation.expiresAtMs)
        : computeExpiryDate(plan, new Date(validation.purchaseDateMs));

    const sub = await db.subscription.upsert({
        where: { userId },
        update: {
            plan,
            status: 'active',
            platform,
            productId,
            expiresAt,
            originalTransactionId: validation.transactionId,
            cancelledAt: null
        },
        create: {
            userId,
            plan,
            status: 'active',
            platform,
            productId,
            expiresAt,
            originalTransactionId: validation.transactionId
        }
    });

    try {
        await grantSubscriptionBoost(userId);
    } catch (error) {
        if (error instanceof Error && error.message === 'already_boosted') {
            logger.debug(`[Subscription] Boost already active for user ${userId}, skipping grant`);
        } else {
            logger.error('[Subscription] Failed to grant subscription boost', error);
        }
    }

    logger.info(`[Subscription] Receipt validated: user=${userId}, plan=${plan}, expires=${expiresAt.toISOString()}`);

    return {
        ok: true,
        subscription: {
            plan: sub.plan as SubscriptionPlan,
            status: sub.status as UserSubscription['status'],
            expiresAt: sub.expiresAt.toISOString(),
            platform: sub.platform as SubscriptionPlatform,
            cancelledAt: sub.cancelledAt ? sub.cancelledAt.toISOString() : null
        }
    };
}

/**
 * Mark a subscription as cancelled (auto-renew off). The user keeps premium until `expiresAt`.
 * Idempotent.
 */
export async function markSubscriptionCancelled(userId: string): Promise<UserSubscription | null> {
    const db = getDatabase();
    const sub = await db.subscription.findUnique({ where: { userId } });
    if (!sub) return null;

    const cancelledAt = sub.cancelledAt ?? new Date();
    const updated = await db.subscription.update({
        where: { userId },
        data: { cancelledAt }
    });

    return {
        plan: updated.plan as SubscriptionPlan,
        status: updated.status as UserSubscription['status'],
        expiresAt: updated.expiresAt.toISOString(),
        platform: updated.platform as SubscriptionPlatform,
        cancelledAt: updated.cancelledAt ? updated.cancelledAt.toISOString() : null
    };
}

export function productIdToPlan(productId: string): SubscriptionPlan {
    if (productId.includes('annual') && !productId.includes('semi')) return 'annual';
    if (productId.includes('semi_annual') || productId.includes('semi-annual')) return 'semi_annual';
    return 'monthly';
}

/**
 * Compute the expiry date for a plan starting from `from`. Handles month-end overflow:
 * e.g. Jan 31 + 1 month must yield Feb 28/29, not Mar 3.
 */
export function computeExpiryDate(plan: SubscriptionPlan, from: Date = new Date()): Date {
    const monthDelta = plan === 'monthly' ? 1 : plan === 'semi_annual' ? 6 : 12;
    return addMonthsClamped(from, monthDelta);
}

function addMonthsClamped(date: Date, months: number): Date {
    const year = date.getFullYear();
    const month = date.getMonth() + months;
    const day = date.getDate();
    const h = date.getHours();
    const m = date.getMinutes();
    const s = date.getSeconds();
    const ms = date.getMilliseconds();
    // Build a candidate; if the day rolled over (e.g. Feb 30 → Mar 2), clamp to the last day of the target month.
    const candidate = new Date(year, month, day, h, m, s, ms);
    if (candidate.getDate() !== day) {
        return new Date(candidate.getFullYear(), candidate.getMonth(), 0, h, m, s, ms);
    }
    return candidate;
}
