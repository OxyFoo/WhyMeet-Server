import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_DeclineRequest, WSResponse_DeclineRequest } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_DeclineRequest>(
    'decline-request',
    async (client: Client, payload): Promise<WSResponse_DeclineRequest> => {
        const { senderId } = payload;
        const db = getDatabase();

        try {
            // Create a skip from current user → sender (so they won't appear again)
            await db.match.upsert({
                where: {
                    senderId_receiverId_category: { senderId: client.userId, receiverId: senderId, category: 'skip' }
                },
                update: {},
                create: { senderId: client.userId, receiverId: senderId, category: 'skip' }
            });

            logger.debug(`[Discovery] Request declined: ${client.userId} declined ${senderId}`);
            return { command: 'decline-request', payload: { success: true } };
        } catch (error) {
            logger.error('[Discovery] Decline request error', error);
            return { command: 'decline-request', payload: { error: 'Internal error' } };
        }
    }
);
