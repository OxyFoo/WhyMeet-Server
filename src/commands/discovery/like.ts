import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_Like, WSResponse_Like } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { getConnectedClients } from '@/server/Server';
import { pushToUser } from '@/services/pushService';
import { t, getUserLanguage } from '@/services/notifI18n';
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
                const lang = await getUserLanguage(candidateId);
                const notification = await db.notification.create({
                    data: {
                        userId: candidateId,
                        type: 'match',
                        title: t(lang, 'match_title'),
                        body: t(lang, 'match_body', { name: currentUser.name })
                    }
                });

                let matchedUserOnline = false;
                for (const c of connectedClients.values()) {
                    if (c.userId === candidateId) {
                        matchedUserOnline = true;
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

                if (!matchedUserOnline) {
                    pushToUser(candidateId, {
                        title: notification.title,
                        body: notification.body,
                        data: { type: 'match', conversationId: conversation.id }
                    });
                }
            }

            logger.info(`[Discovery] Mutual match: ${client.userId} <-> ${candidateId}`);
            return { command: 'like', payload: { matched: true, conversationId: conversation.id } };
        }

        // Increment vibes count for the receiver (they received a like)
        await db.profile.updateMany({
            where: { userId: candidateId },
            data: { statVibes: { increment: 1 } }
        });

        // Create a "like received" notification
        const likerName =
            (await db.user.findUnique({ where: { id: client.userId }, select: { name: true } }))?.name ?? 'Someone';
        const likeLang = await getUserLanguage(candidateId);
        const likeNotif = await db.notification.create({
            data: {
                userId: candidateId,
                type: 'like',
                title: t(likeLang, 'like_title'),
                body: t(likeLang, 'like_body', { name: likerName })
            }
        });

        // Push notification to connected client
        const onlineClients = getConnectedClients();
        let likedUserOnline = false;
        for (const c of onlineClients.values()) {
            if (c.userId === candidateId) {
                likedUserOnline = true;
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

        if (!likedUserOnline) {
            pushToUser(candidateId, {
                title: likeNotif.title,
                body: likeNotif.body,
                data: { type: 'like' }
            });
        }

        logger.debug(`[Discovery] User ${client.userId} liked ${candidateId}`);
        return { command: 'like', payload: { matched: false } };
    } catch (error) {
        logger.error('[Discovery] Like error', error);
        return { command: 'like', payload: { error: 'Internal error' } };
    }
});
