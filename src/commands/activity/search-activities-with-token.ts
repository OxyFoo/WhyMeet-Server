import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_SearchActivitiesWithToken, WSResponse_SearchActivitiesWithToken } from '@oxyfoo/whymeet-types';
import { searchActivities } from '@/services/activityDiscoveryService';
import { getSearchQuota, useSearchQuota } from '@/services/searchQuotaService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_SearchActivitiesWithToken>(
    'search-activities-with-token',
    async (client: Client, payload): Promise<WSResponse_SearchActivitiesWithToken> => {
        try {
            const quota = await getSearchQuota(client.userId);
            if (quota.dailyLimit !== -1 && quota.remaining <= 0) {
                return { command: 'search-activities-with-token', payload: { error: 'no_tokens' } };
            }

            const result = await searchActivities(client.userId, payload.filters);

            const nextQuota = result.activities.length > 0 ? await useSearchQuota(client.userId) : quota;

            return {
                command: 'search-activities-with-token',
                payload: {
                    activities: result.activities,
                    totalCount: result.totalCount,
                    remaining: nextQuota.remaining
                }
            };
        } catch (error) {
            logger.error('[Activity] Search with token error', error);
            return { command: 'search-activities-with-token', payload: { error: 'Internal error' } };
        }
    }
);
