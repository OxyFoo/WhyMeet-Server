import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetPopularActivityTags, WSResponse_GetPopularActivityTags } from '@oxyfoo/whymeet-types';
import { getPopularActivityTags } from '@/services/activityDiscoveryService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetPopularActivityTags>(
    'get-popular-activity-tags',
    async (client: Client, payload): Promise<WSResponse_GetPopularActivityTags> => {
        try {
            const tags = await getPopularActivityTags(client.userId, payload.category);
            return { command: 'get-popular-activity-tags', payload: { tags } };
        } catch (error) {
            logger.error('[Activity] Get popular tags error', error);
            return { command: 'get-popular-activity-tags', payload: { error: 'Internal error' } };
        }
    }
);
