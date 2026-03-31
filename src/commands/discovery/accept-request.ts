import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_AcceptRequest, WSResponse_AcceptRequest } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { getConnectedClients } from '@/server/Server';
import { mapUserToProfile, profileInclude } from '@/services/userMapper';
import { logger } from '@/config/logger';

registerCommand<WSRequest_AcceptRequest>(
    'accept-request',
    async (client: Client, payload): Promise<WSResponse_AcceptRequest> => {
        const { senderId } = payload;
        const db = getDatabase();

        try {
            // Create a like from current user → sender (this makes it mutual)
            await db.match.upsert({
                where: {
                    senderId_receiverId_category: { senderId: client.userId, receiverId: senderId, category: 'like' }
                },
                update: {},
                create: { senderId: client.userId, receiverId: senderId, category: 'like' }
            });

            // Mark both matches as mutual
            await db.match.updateMany({
                where: {
                    OR: [
                        { senderId: client.userId, receiverId: senderId, category: 'like' },
                        { senderId: senderId, receiverId: client.userId, category: 'like' }
                    ]
                },
                data: { mutual: true }
            });

            // Increment match stats for both users
            await db.profile.updateMany({
                where: { userId: { in: [client.userId, senderId] } },
                data: { statMatches: { increment: 1 } }
            });

            // Create a conversation
            const conversation = await db.conversation.create({
                data: {
                    participants: {
                        create: [{ userId: client.userId }, { userId: senderId }]
                    }
                }
            });

            // Notify the sender if connected
            const connectedClients = getConnectedClients();
            const currentUser = await db.user.findUnique({
                where: { id: client.userId },
                include: profileInclude
            });

            if (currentUser) {
                for (const c of connectedClients.values()) {
                    if (c.userId === senderId) {
                        c.send({
                            event: 'new-match',
                            payload: {
                                conversationId: conversation.id,
                                participant: mapUserToProfile(currentUser)
                            }
                        });
                    }
                }
            }

            logger.info(`[Discovery] Request accepted: ${client.userId} accepted ${senderId}`);
            return { command: 'accept-request', payload: { conversationId: conversation.id } };
        } catch (error) {
            logger.error('[Discovery] Accept request error', error);
            return { command: 'accept-request', payload: { error: 'Internal error' } };
        }
    }
);
