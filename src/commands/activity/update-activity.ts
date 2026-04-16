import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_UpdateActivity, WSResponse_UpdateActivity } from '@whymeet/types';
import { updateActivity } from '@/services/activityService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_UpdateActivity>(
    'update-activity',
    async (client: Client, payload): Promise<WSResponse_UpdateActivity> => {
        try {
            const { activityId, data } = payload;

            if (data.title !== undefined && (data.title.length < 3 || data.title.length > 100)) {
                return { command: 'update-activity', payload: { error: 'Title must be 3-100 characters' } };
            }

            if (data.description !== undefined && data.description.length > 2000) {
                return { command: 'update-activity', payload: { error: 'Description too long (2000 max)' } };
            }

            const activity = await updateActivity(activityId, client.userId, data);
            if (!activity) {
                return { command: 'update-activity', payload: { error: 'Activity not found or not the host' } };
            }

            return { command: 'update-activity', payload: { activity } };
        } catch (error) {
            logger.error('[Activity] Update error', error);
            return { command: 'update-activity', payload: { error: 'Internal error' } };
        }
    }
);
