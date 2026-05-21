import type { SubscriptionPlatform, PurchaseErrorCode } from '@oxyfoo/whymeet-types';
import { PRODUCT_IDS } from '@oxyfoo/whymeet-types';
import { logger } from '@/config/logger';

/**
 * Result of a receipt validation request.
 * - `ok=true` → receipt accepted (transactionId is the store-issued identifier).
 * - `ok=false` → receipt rejected, `code` describes the reason.
 */
export type ReceiptValidationResult =
    | { ok: true; transactionId: string; productId: string; purchaseDateMs: number; expiresAtMs?: number }
    | { ok: false; code: PurchaseErrorCode; reason?: string };

export type ProductKind = 'subscription' | 'boost';

/**
 * Validate an in-app purchase receipt server-side.
 *
 * NOTE: This is a structured implementation gate. Real validation against Apple App Store Server API v2
 * and Google Play Developer API must be implemented before production. In `development` (or when the
 * `IAP_TRUST_CLIENT_RECEIPT` env flag is set), receipts are accepted after basic shape validation so the
 * IAP flow can be exercised without store credentials.
 *
 * TODO(prod):
 *  - Apple: use `apple-signin-auth`'s shared HTTP client or the App Store Server Library to call
 *    `/inApps/v1/transactions/{transactionId}` and verify signed JWS payload.
 *  - Google: use `googleapis` `androidpublisher.purchases.subscriptionsv2.get` (or `products.get` for boosts)
 *    with a service account.
 *  - Both: cache results, persist `transactionId`/`originalTransactionId` for refund handling, listen to
 *    S2S notifications (App Store Server Notifications v2 / Google RTDN) to keep `Subscription.status` in sync.
 */
export async function validatePurchaseReceipt(params: {
    userId: string;
    receipt: string;
    platform: SubscriptionPlatform;
    productId: string;
    kind: ProductKind;
}): Promise<ReceiptValidationResult> {
    const { userId, receipt, platform, productId, kind } = params;

    if (!receipt || typeof receipt !== 'string' || receipt.length < 8) {
        return { ok: false, code: 'invalid_receipt', reason: 'empty_or_short' };
    }
    if (platform !== 'ios' && platform !== 'android') {
        return { ok: false, code: 'platform_unavailable', reason: `unknown_platform:${platform}` };
    }
    if (!isKnownProductId(productId, kind)) {
        return { ok: false, code: 'unknown_product', reason: productId };
    }

    const trustClient = shouldTrustClientReceipt();
    if (!trustClient) {
        // Production path placeholder: refuse the receipt loudly so missing wiring is visible.
        logger.error(
            `[Receipts] Server-side validation not implemented for ${platform}/${productId}. ` +
                `Set IAP_TRUST_CLIENT_RECEIPT=1 in non-production environments to bypass.`
        );
        return { ok: false, code: 'platform_unavailable', reason: 'validation_not_implemented' };
    }

    logger.warn(
        `[Receipts] TRUSTING client receipt (dev mode): user=${userId} platform=${platform} product=${productId} kind=${kind}`
    );
    return {
        ok: true,
        transactionId: receipt.slice(0, 64),
        productId,
        purchaseDateMs: Date.now()
    };
}

function shouldTrustClientReceipt(): boolean {
    if (process.env.IAP_TRUST_CLIENT_RECEIPT === '1') return true;
    return process.env.NODE_ENV !== 'production';
}

function isKnownProductId(productId: string, kind: ProductKind): boolean {
    if (kind === 'subscription') {
        return Object.values(PRODUCT_IDS.subscriptions).includes(productId as never);
    }
    return Object.values(PRODUCT_IDS.boosts).includes(productId as never);
}

export function boostPackToProductId(boostPack: 'boost_1d' | 'boost_3d' | 'boost_7d'): string {
    return PRODUCT_IDS.boosts[boostPack];
}
