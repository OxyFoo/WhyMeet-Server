import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_LeaveActivity, WSResponse_LeaveActivity } from '@oxyfoo/whymeet-types';
import { leaveActivity } from '@/services/activityService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_LeaveActivity>(
    'leave-activity',
    async (client: Client, payload): Promise<WSResponse_LeaveActivity> => {
        try {
            const result = await leaveActivity(payload.activityId, client.userId);
            if (result.error) {
                return { command: 'leave-activity', payload: { error: result.error } };
            }
            return { command: 'leave-activity', payload: { success: true } };
        } catch (error) {
            logger.error('[Activity] Leave error', error);
            return { command: 'leave-activity', payload: { error: 'Internal error' } };
        }
    }
);
