import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetActivities, WSResponse_GetActivities } from '@oxyfoo/whymeet-types';
import { getActivities } from '@/services/activityDiscoveryService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetActivities>(
    'get-activities',
    async (client: Client, payload): Promise<WSResponse_GetActivities> => {
        try {
            const result = await getActivities(client.userId, payload.filters);
            return { command: 'get-activities', payload: result };
        } catch (error) {
            logger.error('[Activity] Get activities error', error);
            return { command: 'get-activities', payload: { error: 'Internal error' } };
        }
    }
);
