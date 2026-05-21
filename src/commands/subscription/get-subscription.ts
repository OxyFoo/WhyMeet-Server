import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetSubscription, WSResponse_GetSubscription } from '@oxyfoo/whymeet-types';
import { getSubscription } from '@/services/subscriptionService';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetSubscription>(
    'get-subscription',
    async (client: Client): Promise<WSResponse_GetSubscription> => {
        const db = getDatabase();
        try {
            // Run subscription fetch and override check in parallel — a single
            // subscription row read instead of two (isPremium would re-read it).
            const [subscription, override] = await Promise.all([
                getSubscription(client.userId),
                db.premiumOverride.findUnique({
                    where: { userId: client.userId },
                    select: { forcedPremium: true, expiresAt: true }
                })
            ]);

            const now = new Date();
            const overrideActive = override && override.expiresAt > now;
            // After getSubscription, status is already reconciled; 'active' ≡ premium.
            const premium = overrideActive ? override.forcedPremium : subscription?.status === 'active';

            return { command: 'get-subscription', payload: { subscription, isPremium: premium } };
        } catch (error) {
            logger.error('[Subscription] Get subscription error', error);
            return { command: 'get-subscription', payload: { error: 'Internal error' } };
        }
    }
);
