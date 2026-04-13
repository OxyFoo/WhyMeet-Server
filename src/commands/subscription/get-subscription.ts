import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetSubscription, WSResponse_GetSubscription } from '@whymeet/types';
import { getSubscription, isPremium } from '@/services/subscriptionService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetSubscription>(
    'get-subscription',
    async (client: Client): Promise<WSResponse_GetSubscription> => {
        try {
            const [subscription, premium] = await Promise.all([
                getSubscription(client.userId),
                isPremium(client.userId)
            ]);
            return { command: 'get-subscription', payload: { subscription, isPremium: premium } };
        } catch (error) {
            logger.error('[Subscription] Get subscription error', error);
            return { command: 'get-subscription', payload: { error: 'Internal error' } };
        }
    }
);
