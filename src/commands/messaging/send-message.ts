import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_SendMessage, WSResponse_SendMessage } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { getConnectedClients } from '@/server/Server';
import { logger } from '@/config/logger';

registerCommand<WSRequest_SendMessage>(
    'send-message',
    async (client: Client, payload): Promise<WSResponse_SendMessage> => {
        if (!client.authenticated || !client.userId) {
            return { command: 'send-message', payload: { error: 'Not authenticated' } };
        }

        const { conversationId, text } = payload;
        const db = getDatabase();

        try {
            // Verify user is participant
            const participation = await db.conversationParticipant.findUnique({
                where: { conversationId_userId: { conversationId, userId: client.userId } }
            });

            if (!participation) {
                return { command: 'send-message', payload: { error: 'Not a participant' } };
            }

            // Create message
            const message = await db.message.create({
                data: {
                    conversationId,
                    senderId: client.userId,
                    text
                }
            });

            // Increment unread for other participants
            await db.conversationParticipant.updateMany({
                where: { conversationId, userId: { not: client.userId } },
                data: { unreadCount: { increment: 1 } }
            });

            const messagePayload = {
                id: message.id,
                text: message.text,
                senderId: message.senderId,
                timestamp: message.timestamp.toISOString()
            };

            // Push to other connected participants
            const otherParticipants = await db.conversationParticipant.findMany({
                where: { conversationId, userId: { not: client.userId } }
            });

            const connectedClients = getConnectedClients();
            for (const p of otherParticipants) {
                for (const c of connectedClients.values()) {
                    if (c.userId === p.userId) {
                        c.send({
                            event: 'new-message',
                            payload: { conversationId, message: messagePayload }
                        });
                    }
                }
            }

            return { command: 'send-message', payload: { message: messagePayload } };
        } catch (error) {
            logger.error('[Messaging] Send message error', error);
            return { command: 'send-message', payload: { error: 'Internal error' } };
        }
    }
);
