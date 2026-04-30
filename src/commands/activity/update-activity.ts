import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_UpdateActivity, WSResponse_UpdateActivity } from '@oxyfoo/whymeet-types';
import { updateActivity } from '@/services/activityService';
import { ActivityWouldBecomeIncompleteError } from '@/services/activityCompletion';
import { logger } from '@/config/logger';
import { updateActivitySchema } from '@/config/validation';

registerCommand<WSRequest_UpdateActivity>(
    'update-activity',
    async (client: Client, payload): Promise<WSResponse_UpdateActivity> => {
        const { activityId, data } = payload;

        const parsed = updateActivitySchema.safeParse(data);
        if (!parsed.success) {
            const msg = parsed.error.errors[0]?.message ?? 'Invalid payload';
            return { command: 'update-activity', payload: { error: msg } };
        }

        try {
            const activity = await updateActivity(activityId, client.userId, data);
            if (!activity) {
                return { command: 'update-activity', payload: { error: 'Activity not found or not the host' } };
            }

            return { command: 'update-activity', payload: { activity } };
        } catch (error) {
            if (error instanceof ActivityWouldBecomeIncompleteError) {
                return { command: 'update-activity', payload: { error: 'activityWouldBecomeIncomplete' } };
            }
            logger.error('[Activity] Update error', error);
            return { command: 'update-activity', payload: { error: 'Internal error' } };
        }
    }
);
