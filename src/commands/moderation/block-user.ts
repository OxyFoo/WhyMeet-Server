import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_BlockUser, WSResponse_BlockUser } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_BlockUser>('block-user', async (client: Client, payload): Promise<WSResponse_BlockUser> => {
    const { userId: blockedId } = payload;
    const db = getDatabase();

    try {
        if (blockedId === client.userId) {
            return { command: 'block-user', payload: { error: 'Cannot block yourself' } };
        }

        await db.block.upsert({
            where: {
                blockerId_blockedId: { blockerId: client.userId, blockedId }
            },
            update: {},
            create: { blockerId: client.userId, blockedId }
        });

        // Also remove any existing conversations between the two users
        const participations = await db.conversationParticipant.findMany({
            where: { userId: client.userId },
            select: { conversationId: true }
        });
        const myConvoIds = participations.map((p) => p.conversationId);

        const sharedParticipations = await db.conversationParticipant.findMany({
            where: { userId: blockedId, conversationId: { in: myConvoIds } },
            select: { conversationId: true }
        });

        if (sharedParticipations.length > 0) {
            await db.conversation.deleteMany({
                where: { id: { in: sharedParticipations.map((p) => p.conversationId) } }
            });
        }

        logger.info(`[Moderation] User ${client.userId} blocked ${blockedId}`);
        return { command: 'block-user', payload: { success: true } };
    } catch (error) {
        logger.error('[Moderation] Block error', error);
        return { command: 'block-user', payload: { error: 'Internal error' } };
    }
});
