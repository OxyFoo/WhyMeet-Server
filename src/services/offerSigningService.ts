import crypto from 'crypto';
import { env } from '@/config/env';
import { logger } from '@/config/logger';

const INVISIBLE_SEPARATOR = '\u2063';

interface AppleOfferSignature {
    keyIdentifier: string;
    nonce: string;
    signature: string;
    timestamp: number;
}

/**
 * Sign an Apple Promotional Offer for StoreKit.
 * Uses ECDSA P-256 with the App Store Connect subscription key (.p8).
 *
 * @param productId - The subscription product ID (e.g. "com.whymeet.sub.monthly")
 * @param offerId - The promotional offer ID configured in App Store Connect
 * @param appAccountToken - The user's app account token (can be empty string)
 */
export function signAppleOffer(productId: string, offerId: string, appAccountToken: string = ''): AppleOfferSignature {
    const keyId = env.APPLE_IAP_KEY_ID;
    const privateKeyPem = env.APPLE_IAP_PRIVATE_KEY;
    const bundleId = env.APP_BUNDLE_ID;

    if (!keyId || !privateKeyPem || !bundleId) {
        throw new Error('Apple IAP signing not configured (APPLE_IAP_KEY_ID, APPLE_IAP_PRIVATE_KEY, APP_BUNDLE_ID)');
    }

    const nonce = crypto.randomUUID().toLowerCase();
    const timestamp = Date.now();

    // Payload: fields joined by invisible separator (U+2063)
    const payload = [bundleId, keyId, productId, offerId, appAccountToken, nonce, String(timestamp)].join(
        INVISIBLE_SEPARATOR
    );

    const sign = crypto.createSign('SHA256');
    sign.update(payload);
    const signature = sign.sign(privateKeyPem, 'base64');

    logger.debug(`[OfferSigning] Signed Apple offer: ${offerId} for product: ${productId}`);

    return { keyIdentifier: keyId, nonce, signature, timestamp };
}
