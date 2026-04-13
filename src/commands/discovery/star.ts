import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_Star, WSResponse_Star } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { getConnectedClients } from '@/server/Server';
import { pushToUser } from '@/services/pushService';
import { t, getUserLanguage } from '@/services/notifI18n';
import { mapUserToProfile, profileInclude } from '@/services/userMapper';
import { useSwipe } from '@/services/swipeQuotaService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_Star>('star', async (client: Client, payload): Promise<WSResponse_Star> => {
    const { candidateId } = payload;
    const db = getDatabase();

    try {
        // Check and consume swipe quota
        try {
            await useSwipe(client.userId);
        } catch (err) {
            if (err instanceof Error && err.message === 'quota_exceeded') {
                return { command: 'star', payload: { error: 'quota_exceeded' } };
            }
            throw err;
        }
        // Star is like a super-like
        const match = await db.match.upsert({
            where: {
                senderId_receiverId_category: { senderId: client.userId, receiverId: candidateId, category: 'like' }
            },
            update: { matchContext: 'star' },
            create: { senderId: client.userId, receiverId: candidateId, category: 'like', matchContext: 'star' }
        });

        // Check for mutual match
        const reverse = await db.match.findFirst({
            where: { senderId: candidateId, receiverId: client.userId, category: 'like' }
        });

        if (reverse) {
            await db.match.updateMany({
                where: { id: { in: [match.id, reverse.id] } },
                data: { mutual: true }
            });

            // Increment match stats for both users
            await db.profile.updateMany({
                where: { userId: { in: [client.userId, candidateId] } },
                data: { statMatches: { increment: 1 } }
            });

            const conversation = await db.conversation.create({
                data: {
                    participants: {
                        create: [{ userId: client.userId }, { userId: candidateId }]
                    }
                }
            });

            const connectedClients = getConnectedClients();
            const currentUser = await db.user.findUnique({
                where: { id: client.userId },
                include: profileInclude
            });

            if (currentUser) {
                let candidateOnline = false;
                for (const c of connectedClients.values()) {
                    if (c.userId === candidateId) {
                        candidateOnline = true;
                        c.send({
                            event: 'new-match',
                            payload: {
                                conversationId: conversation.id,
                                participant: mapUserToProfile(currentUser)
                            }
                        });
                    }
                }

                if (!candidateOnline) {
                    const lang = await getUserLanguage(candidateId);
                    pushToUser(candidateId, {
                        title: t(lang, 'match_title'),
                        body: t(lang, 'match_body', { name: currentUser.name }),
                        data: { type: 'match', conversationId: conversation.id }
                    });
                }
            }

            logger.info(`[Discovery] Star mutual match: ${client.userId} <-> ${candidateId}`);
            return { command: 'star', payload: { success: true } };
        }

        // Increment vibes count for the receiver (they received a star)
        await db.profile.updateMany({
            where: { userId: candidateId },
            data: { statVibes: { increment: 1 } }
        });

        logger.debug(`[Discovery] User ${client.userId} starred ${candidateId}`);
        return { command: 'star', payload: { success: true } };
    } catch (error) {
        logger.error('[Discovery] Star error', error);
        return { command: 'star', payload: { error: 'Internal error' } };
    }
});
