import type { MessageType, Message } from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { getClientsForUser } from '@/server/Server';
import { logger } from '@/config/logger';

/**
 * Create a system message in a group conversation (e.g. "user joined / left")
 * and broadcast it to every connected participant via the existing
 * `new-message` WS event. Increments `unreadCount` for everyone except the
 * actor (the user the event is about).
 */
export async function emitGroupSystemMessage(
    conversationId: string,
    actorUserId: string,
    type: Exclude<MessageType, 'text'>
): Promise<void> {
    const db = getDatabase();

    try {
        const conversation = await db.conversation.findUnique({
            where: { id: conversationId },
            select: { id: true, isGroup: true }
        });
        if (!conversation || !conversation.isGroup) return;

        const message = await db.message.create({
            data: {
                conversationId,
                senderId: actorUserId,
                text: '',
                type
            }
        });

        // Increment unread for everyone except the actor
        await db.conversationParticipant.updateMany({
            where: { conversationId, userId: { not: actorUserId } },
            data: { unreadCount: { increment: 1 } }
        });

        // Bump conversation activity timestamp for ordering.
        await db.conversation.update({
            where: { id: conversationId },
            data: { lastMessageAt: message.timestamp }
        });

        const messagePayload: Message = {
            id: message.id,
            text: message.text,
            senderId: message.senderId,
            timestamp: message.timestamp.toISOString(),
            read: false,
            type
        };

        // Broadcast to connected participants (excluding the actor themself —
        // their own UI updates locally on the action).
        const otherParticipants = await db.conversationParticipant.findMany({
            where: { conversationId, userId: { not: actorUserId } },
            select: { userId: true }
        });

        for (const participant of otherParticipants) {
            for (const c of getClientsForUser(participant.userId)) {
                c.send({
                    event: 'new-message',
                    payload: { conversationId, message: messagePayload }
                });
            }
        }
    } catch (error) {
        logger.error('[Messaging] Emit system message failed', error);
    }
}
