import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_AppealSuspension, WSResponse_AppealSuspension } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_AppealSuspension>(
    'appeal-suspension',
    async (client: Client, payload): Promise<WSResponse_AppealSuspension> => {
        const { message } = payload;
        const db = getDatabase();

        try {
            const user = await db.user.findUnique({
                where: { id: client.userId },
                select: { suspended: true, appealRequestedAt: true }
            });

            if (!user || !user.suspended) {
                return { command: 'appeal-suspension', payload: { error: 'Account is not suspended' } };
            }

            if (user.appealRequestedAt) {
                return { command: 'appeal-suspension', payload: { error: 'Appeal already submitted' } };
            }

            if (message && message.length > 500) {
                return { command: 'appeal-suspension', payload: { error: 'Message too long (500 max)' } };
            }

            await db.user.update({
                where: { id: client.userId },
                data: {
                    appealMessage: message ?? null,
                    appealRequestedAt: new Date()
                }
            });

            logger.info(`[Moderation] User ${client.userId} appealed suspension`);
            return { command: 'appeal-suspension', payload: { success: true } };
        } catch (error) {
            logger.error('[Moderation] Appeal error', error);
            return { command: 'appeal-suspension', payload: { error: 'Internal error' } };
        }
    }
);
