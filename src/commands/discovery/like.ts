import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_Like, WSResponse_Like } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { getConnectedClients } from '@/server/Server';
import { mapUserToProfile, profileInclude } from '@/services/userMapper';
import { logger } from '@/config/logger';

registerCommand<WSRequest_Like>('like', async (client: Client, payload): Promise<WSResponse_Like> => {
    const { candidateId } = payload;
    const db = getDatabase();

    try {
        // Create or update the match record
        const match = await db.match.upsert({
            where: {
                senderId_receiverId_category: { senderId: client.userId, receiverId: candidateId, category: 'like' }
            },
            update: {},
            create: { senderId: client.userId, receiverId: candidateId, category: 'like' }
        });

        // Check for mutual match (did the other person also like us?)
        const reverse = await db.match.findFirst({
            where: { senderId: candidateId, receiverId: client.userId, category: 'like' }
        });

        if (reverse) {
            // Mark both as mutual
            await db.match.updateMany({
                where: { id: { in: [match.id, reverse.id] } },
                data: { mutual: true }
            });

            // Increment match stats for both users
            await db.profile.updateMany({
                where: { userId: { in: [client.userId, candidateId] } },
                data: { statMatches: { increment: 1 } }
            });

            // Create a conversation
            const conversation = await db.conversation.create({
                data: {
                    participants: {
                        create: [{ userId: client.userId }, { userId: candidateId }]
                    }
                }
            });

            // Notify the other user if connected
            const connectedClients = getConnectedClients();
            const currentUser = await db.user.findUnique({
                where: { id: client.userId },
                include: profileInclude
            });

            if (currentUser) {
                // Create persistent notification for the matched user
                const notification = await db.notification.create({
                    data: {
                        userId: candidateId,
                        type: 'match',
                        title: 'New Match!',
                        body: `You matched with ${currentUser.name}`
                    }
                });

                for (const c of connectedClients.values()) {
                    if (c.userId === candidateId) {
                        c.send({
                            event: 'new-match',
                            payload: {
                                conversationId: conversation.id,
                                participant: mapUserToProfile(currentUser)
                            }
                        });
                        c.send({
                            event: 'notification',
                            payload: {
                                notification: {
                                    id: notification.id,
                                    type: 'match' as const,
                                    title: notification.title,
                                    body: notification.body,
                                    read: false,
                                    createdAt: notification.createdAt.toISOString()
                                }
                            }
                        });
                    }
                }
            }

            logger.info(`[Discovery] Mutual match: ${client.userId} <-> ${candidateId}`);
            return { command: 'like', payload: { matched: true } };
        }

        // Increment vibes count for the receiver (they received a like)
        await db.profile.updateMany({
            where: { userId: candidateId },
            data: { statVibes: { increment: 1 } }
        });

        // Create a "like received" notification
        const likerName =
            (await db.user.findUnique({ where: { id: client.userId }, select: { name: true } }))?.name ?? 'Someone';
        const likeNotif = await db.notification.create({
            data: {
                userId: candidateId,
                type: 'like',
                title: 'Someone likes you!',
                body: `${likerName} liked your profile`
            }
        });

        // Push notification to connected client
        const onlineClients = getConnectedClients();
        for (const c of onlineClients.values()) {
            if (c.userId === candidateId) {
                c.send({
                    event: 'notification',
                    payload: {
                        notification: {
                            id: likeNotif.id,
                            type: 'like' as const,
                            title: likeNotif.title,
                            body: likeNotif.body,
                            read: false,
                            createdAt: likeNotif.createdAt.toISOString()
                        }
                    }
                });
            }
        }

        logger.debug(`[Discovery] User ${client.userId} liked ${candidateId}`);
        return { command: 'like', payload: { matched: false } };
    } catch (error) {
        logger.error('[Discovery] Like error', error);
        return { command: 'like', payload: { error: 'Internal error' } };
    }
});
