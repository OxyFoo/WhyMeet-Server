import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetActivity, WSResponse_GetActivity } from '@oxyfoo/whymeet-types';
import { getActivity } from '@/services/activityService';
import { useActivityQuota } from '@/services/activityQuotaService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetActivity>(
    'get-activity',
    async (client: Client, payload): Promise<WSResponse_GetActivity> => {
        try {
            const activity = await getActivity(payload.activityId, client.userId);
            if (!activity) {
                return { command: 'get-activity', payload: { error: 'Activity not found' } };
            }

            try {
                await useActivityQuota(client.userId);
            } catch (err) {
                if (err instanceof Error && err.message === 'activity_quota_exceeded') {
                    return { command: 'get-activity', payload: { error: 'activity_quota_exceeded' } };
                }
                throw err;
            }
            return { command: 'get-activity', payload: { activity } };
        } catch (error) {
            logger.error('[Activity] Get error', error);
            return { command: 'get-activity', payload: { error: 'Internal error' } };
        }
    }
);
