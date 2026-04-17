import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_JoinActivity, WSResponse_JoinActivity } from '@oxyfoo/whymeet-types';
import { joinActivity } from '@/services/activityService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_JoinActivity>(
    'join-activity',
    async (client: Client, payload): Promise<WSResponse_JoinActivity> => {
        try {
            const result = await joinActivity(payload.activityId, client.userId);
            if ('error' in result) {
                return { command: 'join-activity', payload: { error: result.error } };
            }
            return { command: 'join-activity', payload: result };
        } catch (error) {
            logger.error('[Activity] Join error', error);
            return { command: 'join-activity', payload: { error: 'Internal error' } };
        }
    }
);
