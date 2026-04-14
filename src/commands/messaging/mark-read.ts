import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_MarkRead, WSResponse_MarkRead } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { getConnectedClients } from '@/server/Server';
import { logger } from '@/config/logger';

registerCommand<WSRequest_MarkRead>('mark-read', async (client: Client, payload): Promise<WSResponse_MarkRead> => {
    const { conversationId } = payload;
    const db = getDatabase();

    try {
        // Verify user is participant
        const participation = await db.conversationParticipant.findUnique({
            where: { conversationId_userId: { conversationId, userId: client.userId } }
        });

        if (!participation) {
            return { command: 'mark-read', payload: { error: 'Not a participant' } };
        }

        // Mark all unread messages from other senders as read
        await db.message.updateMany({
            where: {
                conversationId,
                senderId: { not: client.userId },
                read: false
            },
            data: { read: true }
        });

        // Reset unread count for this participant
        await db.conversationParticipant.update({
            where: { conversationId_userId: { conversationId, userId: client.userId } },
            data: { unreadCount: 0 }
        });

        // Notify other participants so they can update read status in UI
        const otherParticipants = await db.conversationParticipant.findMany({
            where: { conversationId, userId: { not: client.userId } }
        });

        const connectedClients = getConnectedClients();
        for (const p of otherParticipants) {
            for (const c of connectedClients.values()) {
                if (c.userId === p.userId) {
                    c.send({
                        event: 'mark-read',
                        payload: { conversationId }
                    });
                }
            }
        }

        return { command: 'mark-read', payload: { success: true } };
    } catch (error) {
        logger.error('[Messaging] Mark read error', error);
        return { command: 'mark-read', payload: { error: 'Internal error' } };
    }
});
