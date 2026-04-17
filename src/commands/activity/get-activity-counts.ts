import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetActivityCounts, WSResponse_GetActivityCounts } from '@oxyfoo/whymeet-types';
import { getActivityCounts } from '@/services/activityDiscoveryService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetActivityCounts>(
    'get-activity-counts',
    async (client: Client): Promise<WSResponse_GetActivityCounts> => {
        try {
            const counts = await getActivityCounts(client.userId);
            return { command: 'get-activity-counts', payload: { counts } };
        } catch (error) {
            logger.error('[Activity] Get activity counts error', error);
            return { command: 'get-activity-counts', payload: { error: 'Internal error' } };
        }
    }
);
