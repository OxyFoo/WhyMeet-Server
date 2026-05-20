import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_Like, WSResponse_Like } from '@oxyfoo/whymeet-types';
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
import { enrichProfileIntentionFromLike } from '@/services/intentionProfileEnrichment';
import { pushCountersToUser } from '@/services/userCounters';
import { logger } from '@/config/logger';

registerCommand<WSRequest_Like>('like', async (client: Client, payload): Promise<WSResponse_Like> => {
    const { candidateId, selection } = payload;
    const db = getDatabase();
    const selectionError = selection ? validateIntentionSelection(selection) : null;
    if (selectionError) return { command: 'like', payload: { error: selectionError } };

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
                return { command: 'like', payload: { error: 'quota_exceeded' } };
            }
            throw err;
        }
        // Track in exclusion cache so candidate won't reappear in discovery
        addExcluded(client.userId, candidateId).catch(() => {});

        // Verify candidate is still active
        const candidate = await db.user.findUnique({
            where: { id: candidateId },
            select: { banned: true, suspended: true, deleted: true }
        });
        if (!candidate || candidate.banned || candidate.suspended || candidate.deleted) {
            return { command: 'like', payload: { error: 'User not found' } };
        }

        // Create or update the match record
        const match = await db.match.upsert({
            where: {
                senderId_receiverId_category: { senderId: client.userId, receiverId: candidateId, category: 'like' }
            },
            update: intentionData,
            create: { senderId: client.userId, receiverId: candidateId, category: 'like', ...intentionData }
        });

        // Auto-add the intention to the liker's profile if they don't have it yet
        const intentionAdded = selectedIntention
            ? await enrichProfileIntentionFromLike(client.userId, selectedIntention.key)
            : false;

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

                const matchedUserClients = getClientsForUser(candidateId);
                for (const c of matchedUserClients) {
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

                if (matchedUserClients.length === 0) {
                    pushToUser(
                        candidateId,
                        {
                            title: notification.title,
                            body: notification.body,
                            data: { type: 'match', conversationId: conversation.id }
                        },
                        'match'
                    );
                }
            }

            await Promise.all([pushCountersToUser(client.userId), pushCountersToUser(candidateId)]);

            logger.info(`[Discovery] Mutual match: ${client.userId} <-> ${candidateId}`);
            return { command: 'like', payload: { matched: true, conversationId: conversation.id, intentionAdded } };
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
        const likedUserClients = getClientsForUser(candidateId);
        for (const c of likedUserClients) {
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

        if (likedUserClients.length === 0) {
            pushToUser(
                candidateId,
                {
                    title: likeNotif.title,
                    body: likeNotif.body,
                    data: { type: 'like' }
                },
                'like'
            );
        }

        await pushCountersToUser(candidateId);

        logger.debug(`[Discovery] User ${client.userId} liked ${candidateId}`);
        return { command: 'like', payload: { matched: false, intentionAdded } };
    } catch (error) {
        logger.error('[Discovery] Like error', error);
        return { command: 'like', payload: { error: 'Internal error' } };
    }
});
