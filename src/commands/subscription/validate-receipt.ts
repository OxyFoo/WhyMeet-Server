import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_ValidateReceipt, WSResponse_ValidateReceipt } from '@oxyfoo/whymeet-types';
import { validateReceipt, isPremium } from '@/services/subscriptionService';
import { getBoostStatus } from '@/services/boostService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_ValidateReceipt>(
    'validate-receipt',
    async (client: Client, payload): Promise<WSResponse_ValidateReceipt> => {
        const { receipt, platform, productId } = payload;

        try {
            const subscription = await validateReceipt(client.userId, receipt, platform, productId);
            const [premium, boost] = await Promise.all([isPremium(client.userId), getBoostStatus(client.userId)]);

            return {
                command: 'validate-receipt',
                payload: { subscription, isPremium: premium, boost }
            };
        } catch (error) {
            logger.error('[Subscription] Validate receipt error', error);
            return { command: 'validate-receipt', payload: { error: 'Internal error' } };
        }
    }
);
