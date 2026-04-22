import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetCandidateActivities, WSResponse_GetCandidateActivities } from '@oxyfoo/whymeet-types';
import { getActivities } from '@/services/activityDiscoveryService';
import { getQuota } from '@/services/swipeQuotaService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetCandidateActivities>(
    'get-candidate-activities',
    async (client: Client, payload): Promise<WSResponse_GetCandidateActivities> => {
        try {
            const { activities, totalCount } = await getActivities(client.userId, {
                category: payload.category,
                tags: payload.tags,
                query: payload.query
            });

            const quota = await getQuota(client.userId);

            return {
                command: 'get-candidate-activities',
                payload: {
                    activities,
                    totalAvailable: totalCount,
                    swipesRemaining: quota.swipesRemaining,
                    dailySwipeLimit: quota.dailySwipeLimit
                }
            };
        } catch (error) {
            logger.error('[Activity] Get candidate activities error', error);
            return { command: 'get-candidate-activities', payload: { error: 'Internal error' } };
        }
    }
);
