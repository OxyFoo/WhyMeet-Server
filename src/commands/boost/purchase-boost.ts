import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_PurchaseBoost, WSResponse_PurchaseBoost } from '@oxyfoo/whymeet-types';
import { BOOST_DURATION_DAYS } from '@oxyfoo/whymeet-types';
import { purchaseBoost } from '@/services/boostService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_PurchaseBoost>(
    'purchase-boost',
    async (client: Client, payload): Promise<WSResponse_PurchaseBoost> => {
        const { boostPack } = payload;

        // TODO: Validate receipt with Apple/Google before granting boost
        // For now, we trust the receipt (real validation to be added)

        const durationDays = BOOST_DURATION_DAYS[boostPack];
        if (!durationDays) {
            return { command: 'purchase-boost', payload: { error: 'Invalid boost pack' } };
        }

        try {
            const boost = await purchaseBoost(client.userId, durationDays);
            return { command: 'purchase-boost', payload: { boost } };
        } catch (error) {
            if (error instanceof Error && error.message === 'already_boosted') {
                return { command: 'purchase-boost', payload: { error: 'already_boosted' } };
            }
            logger.error('[Boost] Purchase error', error);
            return { command: 'purchase-boost', payload: { error: 'Internal error' } };
        }
    }
);
