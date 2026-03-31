import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetMessages, WSResponse_GetMessages } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetMessages>(
    'get-messages',
    async (client: Client, payload): Promise<WSResponse_GetMessages> => {
        const { conversationId, cursor, limit = 50 } = payload;
        const db = getDatabase();
        const take = Math.min(limit, 100);

        try {
            // Verify user is participant
            const participation = await db.conversationParticipant.findUnique({
                where: { conversationId_userId: { conversationId, userId: client.userId } }
            });

            if (!participation) {
                return { command: 'get-messages', payload: { error: 'Not a participant' } };
            }

            const messages = await db.message.findMany({
                where: {
                    conversationId,
                    ...(cursor ? { timestamp: { lt: new Date(cursor) } } : {})
                },
                orderBy: { timestamp: 'desc' },
                take: take + 1
            });

            const hasMore = messages.length > take;
            if (hasMore) messages.pop();
            messages.reverse();

            // Mark as read only on first page
            if (!cursor) {
                await db.conversationParticipant.update({
                    where: { conversationId_userId: { conversationId, userId: client.userId } },
                    data: { unreadCount: 0 }
                });
            }

            return {
                command: 'get-messages',
                payload: {
                    messages: messages.map((m) => ({
                        id: m.id,
                        text: m.text,
                        senderId: m.senderId,
                        timestamp: m.timestamp.toISOString()
                    })),
                    hasMore
                }
            };
        } catch (error) {
            logger.error('[Messaging] Get messages error', error);
            return { command: 'get-messages', payload: { error: 'Internal error' } };
        }
    }
);
