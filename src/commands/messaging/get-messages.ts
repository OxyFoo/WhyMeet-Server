import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetMessages, WSResponse_GetMessages } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetMessages>(
    'get-messages',
    async (client: Client, payload): Promise<WSResponse_GetMessages> => {
        const { conversationId } = payload;
        const db = getDatabase();

        try {
            // Verify user is participant
            const participation = await db.conversationParticipant.findUnique({
                where: { conversationId_userId: { conversationId, userId: client.userId } }
            });

            if (!participation) {
                return { command: 'get-messages', payload: { error: 'Not a participant' } };
            }

            const messages = await db.message.findMany({
                where: { conversationId },
                orderBy: { timestamp: 'asc' }
            });

            // Mark as read
            await db.conversationParticipant.update({
                where: { conversationId_userId: { conversationId, userId: client.userId } },
                data: { unreadCount: 0 }
            });

            return {
                command: 'get-messages',
                payload: {
                    messages: messages.map((m) => ({
                        id: m.id,
                        text: m.text,
                        senderId: m.senderId,
                        timestamp: m.timestamp.toISOString()
                    }))
                }
            };
        } catch (error) {
            logger.error('[Messaging] Get messages error', error);
            return { command: 'get-messages', payload: { error: 'Internal error' } };
        }
    }
);
