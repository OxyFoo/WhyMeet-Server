import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_CreateActivity, WSResponse_CreateActivity } from '@whymeet/types';
import { createActivity } from '@/services/activityService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_CreateActivity>(
    'create-activity',
    async (client: Client, payload): Promise<WSResponse_CreateActivity> => {
        try {
            if (!payload.title || payload.title.length < 3) {
                return { command: 'create-activity', payload: { error: 'Title must be at least 3 characters' } };
            }

            if (payload.title.length > 100) {
                return { command: 'create-activity', payload: { error: 'Title too long (100 max)' } };
            }

            if (payload.description && payload.description.length > 2000) {
                return { command: 'create-activity', payload: { error: 'Description too long (2000 max)' } };
            }

            const activity = await createActivity(client.userId, payload);
            return { command: 'create-activity', payload: { activity } };
        } catch (error) {
            logger.error('[Activity] Create error', error);
            return { command: 'create-activity', payload: { error: 'Internal error' } };
        }
    }
);
