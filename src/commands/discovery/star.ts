import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_Star, WSResponse_Star } from '@oxyfoo/whymeet-types';
import { getIntention } from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { getClientsForUser } from '@/server/Server';
import { pushToUser } from '@/services/pushService';
import { t, getUserLanguage } from '@/services/notifI18n';
import { mapUserToProfile, profileInclude } from '@/services/userMapper';
import { useSwipeQuota } from '@/services/swipeQuotaService';
import { addExcluded } from '@/services/excludeCache';
import { validateIntentionSelection } from '@/config/validation';
import { normalizeActiveIntentionSelection } from '@/services/intentionKeys';
import { logger } from '@/config/logger';

registerCommand<WSRequest_Star>('star', async (client: Client, payload): Promise<WSResponse_Star> => {
    const { candidateId, selection } = payload;
    const db = getDatabase();
    const selectionError = selection ? validateIntentionSelection(selection) : null;
    if (selectionError) return { command: 'star', payload: { error: selectionError } };

    const normalizedSelection = selection ? normalizeActiveIntentionSelection(selection) : null;
    const selectedIntention = normalizedSelection ? getIntention(normalizedSelection.intentionKey) : null;
    const intentionData = selectedIntention
        ? {
              categoryKey: selectedIntention.categoryKey,
              intentionKey: selectedIntention.key
          }
        : {};

    try {
        // Check and consume swipe quota
        try {
            await useSwipeQuota(client.userId);
        } catch (err) {
            if (err instanceof Error && err.message === 'quota_exceeded') {
                return { command: 'star', payload: { error: 'quota_exceeded' } };
            }
            throw err;
        }
        // Track in exclusion cache
        addExcluded(client.userId, candidateId).catch(() => {});

        // Verify candidate is still active
        const candidateUser = await db.user.findUnique({
            where: { id: candidateId },
            select: { banned: true, suspended: true, deleted: true }
        });
        if (!candidateUser || candidateUser.banned || candidateUser.suspended || candidateUser.deleted) {
            return { command: 'star', payload: { error: 'User not found' } };
        }

        // Star is like a super-like
        const match = await db.match.upsert({
            where: {
                senderId_receiverId_category: { senderId: client.userId, receiverId: candidateId, category: 'like' }
            },
            update: { matchContext: 'star', ...intentionData },
            create: {
                senderId: client.userId,
                receiverId: candidateId,
                category: 'like',
                matchContext: 'star',
                ...intentionData
            }
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

            const currentUser = await db.user.findUnique({
                where: { id: client.userId },
                include: profileInclude
            });

            if (currentUser) {
                const candidateClients = getClientsForUser(candidateId);
                for (const c of candidateClients) {
                    c.send({
                        event: 'new-match',
                        payload: {
                            conversationId: conversation.id,
                            participant: mapUserToProfile(currentUser)
                        }
                    });
                }

                if (candidateClients.length === 0) {
                    const lang = await getUserLanguage(candidateId);
                    pushToUser(
                        candidateId,
                        {
                            title: t(lang, 'match_title'),
                            body: t(lang, 'match_body', { name: currentUser.name }),
                            data: { type: 'match', conversationId: conversation.id }
                        },
                        'match'
                    );
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

        // Create a "star received" notification (shown like a like)
        const starrerName =
            (await db.user.findUnique({ where: { id: client.userId }, select: { name: true } }))?.name ?? 'Someone';
        const starLang = await getUserLanguage(candidateId);
        const starNotif = await db.notification.create({
            data: {
                userId: candidateId,
                type: 'like',
                title: t(starLang, 'like_title'),
                body: t(starLang, 'like_body', { name: starrerName })
            }
        });

        const starredUserClients = getClientsForUser(candidateId);
        for (const c of starredUserClients) {
            c.send({
                event: 'notification',
                payload: {
                    notification: {
                        id: starNotif.id,
                        type: 'like' as const,
                        title: starNotif.title,
                        body: starNotif.body,
                        read: false,
                        createdAt: starNotif.createdAt.toISOString()
                    }
                }
            });
        }

        if (starredUserClients.length === 0) {
            pushToUser(
                candidateId,
                {
                    title: starNotif.title,
                    body: starNotif.body,
                    data: { type: 'like' }
                },
                'like'
            );
        }

        logger.debug(`[Discovery] User ${client.userId} starred ${candidateId}`);
        return { command: 'star', payload: { success: true } };
    } catch (error) {
        logger.error('[Discovery] Star error', error);
        return { command: 'star', payload: { error: 'Internal error' } };
    }
});
