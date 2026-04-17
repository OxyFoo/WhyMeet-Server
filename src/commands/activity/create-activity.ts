import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_CreateActivity, WSResponse_CreateActivity } from '@oxyfoo/whymeet-types';
import { createActivity } from '@/services/activityService';
import { logger } from '@/config/logger';
import { createActivitySchema } from '@/config/validation';

registerCommand<WSRequest_CreateActivity>(
    'create-activity',
    async (client: Client, payload): Promise<WSResponse_CreateActivity> => {
        const parsed = createActivitySchema.safeParse(payload);
        if (!parsed.success) {
            const msg = parsed.error.errors[0]?.message ?? 'Invalid payload';
            return { command: 'create-activity', payload: { error: msg } };
        }

        try {
            const activity = await createActivity(client.userId, payload);
            return { command: 'create-activity', payload: { activity } };
        } catch (error) {
            logger.error('[Activity] Create error', error);
            return { command: 'create-activity', payload: { error: 'Internal error' } };
        }
    }
);
