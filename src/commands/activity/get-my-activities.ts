import { z } from 'zod';
import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetMyActivities, WSResponse_GetMyActivities } from '@oxyfoo/whymeet-types';
import { getMyActivities } from '@/services/activityDiscoveryService';
import { logger } from '@/config/logger';

const payloadSchema = z.object({
    role: z.enum(['host', 'participant']),
    cursor: z.string().optional(),
    limit: z.number().int().positive().optional()
});

registerCommand<WSRequest_GetMyActivities>(
    'get-my-activities',
    async (client: Client, payload): Promise<WSResponse_GetMyActivities> => {
        try {
            const parsed = payloadSchema.safeParse(payload);
            if (!parsed.success) {
                return { command: 'get-my-activities', payload: { error: 'Invalid role parameter' } };
            }

            const result = await getMyActivities(client.userId, parsed.data.role, {
                cursor: parsed.data.cursor,
                limit: parsed.data.limit
            });
            return { command: 'get-my-activities', payload: result };
        } catch (error) {
            logger.error('[Activity] Get my activities error', error);
            return { command: 'get-my-activities', payload: { error: 'Internal error' } };
        }
    }
);
