import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_SearchActivities, WSResponse_SearchActivities } from '@whymeet/types';
import { searchActivities } from '@/services/activityDiscoveryService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_SearchActivities>(
    'search-activities',
    async (client: Client, payload): Promise<WSResponse_SearchActivities> => {
        try {
            const result = await searchActivities(client.userId, payload.filters);
            return { command: 'search-activities', payload: result };
        } catch (error) {
            logger.error('[Activity] Search activities error', error);
            return { command: 'search-activities', payload: { error: 'Internal error' } };
        }
    }
);
