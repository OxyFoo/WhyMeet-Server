import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_UnblockUser, WSResponse_UnblockUser } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_UnblockUser>(
    'unblock-user',
    async (client: Client, payload): Promise<WSResponse_UnblockUser> => {
        const { userId } = payload;
        const db = getDatabase();

        try {
            await db.block.delete({
                where: {
                    blockerId_blockedId: { blockerId: client.userId, blockedId: userId }
                }
            });

            logger.info(`[Moderation] User ${client.userId} unblocked ${userId}`);
            return { command: 'unblock-user', payload: { success: true } };
        } catch (error) {
            logger.error('[Moderation] Unblock error', error);
            return { command: 'unblock-user', payload: { error: 'Internal error' } };
        }
    }
);
