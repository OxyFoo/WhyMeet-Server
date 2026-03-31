import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_Unmatch, WSResponse_Unmatch } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_Unmatch>('unmatch', async (client: Client, payload): Promise<WSResponse_Unmatch> => {
    const { userId: targetId } = payload;
    const db = getDatabase();

    try {
        if (targetId === client.userId) {
            return { command: 'unmatch', payload: { error: 'Cannot unmatch yourself' } };
        }

        // Delete all matches between the two users (both directions)
        await db.match.deleteMany({
            where: {
                OR: [
                    { senderId: client.userId, receiverId: targetId },
                    { senderId: targetId, receiverId: client.userId }
                ]
            }
        });

        // Delete shared conversations
        const participations = await db.conversationParticipant.findMany({
            where: { userId: client.userId },
            select: { conversationId: true }
        });
        const myConvoIds = participations.map((p) => p.conversationId);

        const sharedParticipations = await db.conversationParticipant.findMany({
            where: { userId: targetId, conversationId: { in: myConvoIds } },
            select: { conversationId: true }
        });

        if (sharedParticipations.length > 0) {
            await db.conversation.deleteMany({
                where: { id: { in: sharedParticipations.map((p) => p.conversationId) } }
            });
        }

        logger.info(`[Moderation] User ${client.userId} unmatched ${targetId}`);
        return { command: 'unmatch', payload: { success: true } };
    } catch (error) {
        logger.error('[Moderation] Unmatch error', error);
        return { command: 'unmatch', payload: { error: 'Internal error' } };
    }
});
