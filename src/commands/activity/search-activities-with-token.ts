import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_SearchActivitiesWithToken, WSResponse_SearchActivitiesWithToken } from '@oxyfoo/whymeet-types';
import { searchActivities } from '@/services/activityDiscoveryService';
import { getBalance, useToken } from '@/services/tokenService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_SearchActivitiesWithToken>(
    'search-activities-with-token',
    async (client: Client, payload): Promise<WSResponse_SearchActivitiesWithToken> => {
        try {
            const balance = await getBalance(client.userId);
            if (balance.tokens <= 0) {
                return { command: 'search-activities-with-token', payload: { error: 'no_tokens' } };
            }

            const result = await searchActivities(client.userId, payload.filters);

            const newBalance = await useToken(client.userId);

            return {
                command: 'search-activities-with-token',
                payload: {
                    activities: result.activities,
                    totalCount: result.totalCount,
                    tokensRemaining: newBalance.tokens
                }
            };
        } catch (error) {
            logger.error('[Activity] Search with token error', error);
            return { command: 'search-activities-with-token', payload: { error: 'Internal error' } };
        }
    }
);
