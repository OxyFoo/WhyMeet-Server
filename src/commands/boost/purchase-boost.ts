import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_PurchaseBoost, WSResponse_PurchaseBoost } from '@oxyfoo/whymeet-types';
import { BOOST_DURATION_DAYS } from '@oxyfoo/whymeet-types';
import { purchaseBoost } from '@/services/boostService';
import { validatePurchaseReceipt, boostPackToProductId } from '@/services/receiptValidationService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_PurchaseBoost>(
    'purchase-boost',
    async (client: Client, payload): Promise<WSResponse_PurchaseBoost> => {
        const { boostPack, receipt, platform } = payload;

        const durationDays = BOOST_DURATION_DAYS[boostPack];
        if (!durationDays) {
            return { command: 'purchase-boost', payload: { error: 'Invalid boost pack', code: 'unknown_product' } };
        }

        const productId = boostPackToProductId(boostPack);
        const validation = await validatePurchaseReceipt({
            userId: client.userId,
            receipt,
            platform,
            productId,
            kind: 'boost'
        });

        if (!validation.ok) {
            logger.warn(
                `[Boost] Receipt rejected: user=${client.userId} code=${validation.code} reason=${validation.reason ?? '-'}`
            );
            return {
                command: 'purchase-boost',
                payload: { error: validation.reason ?? validation.code, code: validation.code }
            };
        }

        try {
            const boost = await purchaseBoost(client.userId, durationDays);
            return { command: 'purchase-boost', payload: { boost } };
        } catch (error) {
            if (error instanceof Error && error.message === 'already_boosted') {
                return { command: 'purchase-boost', payload: { error: 'already_boosted', code: 'already_boosted' } };
            }
            logger.error('[Boost] Purchase error', error);
            return { command: 'purchase-boost', payload: { error: 'Internal error', code: 'unknown' } };
        }
    }
);
