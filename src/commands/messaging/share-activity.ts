import { z } from 'zod';
import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_ShareActivity, WSResponse_ShareActivity, Message } from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { getClientsForUser } from '@/server/Server';
import { pushToUser } from '@/services/pushService';
import { logger } from '@/config/logger';
import { LIMITS } from '@/config/validation';
import { encryptText } from '@/services/messageEncryption';
import { pushCountersToUser } from '@/services/userCounters';
import { getActivity } from '@/services/activityService';

const MAX_SHARE_CONVERSATIONS = 10;

const shareActivitySchema = z.object({
    activityId: z.string().min(1),
    conversationIds: z
        .array(z.string().min(1))
        .min(1, 'At least one conversation is required')
        .max(MAX_SHARE_CONVERSATIONS, `Cannot share to more than ${MAX_SHARE_CONVERSATIONS} conversations`),
    text: z.string().max(LIMITS.MESSAGE_MAX).optional()
});

registerCommand<WSRequest_ShareActivity>(
    'share-activity',
    async (client: Client, payload): Promise<WSResponse_ShareActivity> => {
        const parsed = shareActivitySchema.safeParse(payload);
        if (!parsed.success) {
            const msg = parsed.error.errors[0]?.message ?? 'Invalid payload';
            return { command: 'share-activity', payload: { error: msg } };
        }

        const { activityId, text } = parsed.data;
        // Deduplicate conversation ids
        const conversationIds = Array.from(new Set(parsed.data.conversationIds));
        const db = getDatabase();

        try {
            // Sender must be available
            const sender = await db.user.findUnique({
                where: { id: client.userId },
                select: { banned: true, suspended: true, deleted: true, name: true }
            });
            if (!sender || sender.banned || sender.suspended || sender.deleted) {
                return { command: 'share-activity', payload: { error: 'Account unavailable' } };
            }

            // Authorize: sender must be able to view the activity. Reuses
            // the same visibility logic as `get-activity` (host/participant
            // bypass + targeting filters).
            const activity = await getActivity(activityId, client.userId);
            if (!activity) {
                return { command: 'share-activity', payload: { error: 'Activity not available' } };
            }
            if (activity.isCancelled || activity.isArchived) {
                return { command: 'share-activity', payload: { error: 'Activity not available' } };
            }

            // Filter conversations the sender is actually a participant of.
            const participations = await db.conversationParticipant.findMany({
                where: { conversationId: { in: conversationIds }, userId: client.userId },
                select: { conversationId: true }
            });
            const validIds = new Set(participations.map((p) => p.conversationId));
            const failedConversationIds = conversationIds.filter((id) => !validIds.has(id));
            const targetIds = conversationIds.filter((id) => validIds.has(id));

            if (targetIds.length === 0) {
                return {
                    command: 'share-activity',
                    payload: { error: 'No valid conversations', failedConversationIds }
                };
            }

            const encryptedText = encryptText(text ?? '');
            const senderName = sender.name || 'Someone';
            const createdMessages: Message[] = [];

            for (const conversationId of targetIds) {
                const message = await db.message.create({
                    data: {
                        conversationId,
                        senderId: client.userId,
                        text: encryptedText,
                        type: 'shared_activity',
                        activityId
                    }
                });

                await db.conversationParticipant.updateMany({
                    where: { conversationId, userId: { not: client.userId } },
                    data: { unreadCount: { increment: 1 } }
                });

                await db.conversation.update({
                    where: { id: conversationId },
                    data: { lastMessageAt: message.timestamp }
                });

                const messagePayload: Message = {
                    id: message.id,
                    text: text ?? '',
                    senderId: message.senderId,
                    timestamp: message.timestamp.toISOString(),
                    read: false,
                    type: 'shared_activity',
                    activityId
                };
                createdMessages.push(messagePayload);

                const otherParticipants = await db.conversationParticipant.findMany({
                    where: { conversationId, userId: { not: client.userId } },
                    select: { userId: true }
                });

                for (const p of otherParticipants) {
                    const userClients = getClientsForUser(p.userId);
                    for (const c of userClients) {
                        c.send({
                            event: 'new-message',
                            payload: { conversationId, message: messagePayload }
                        });
                    }

                    if (userClients.length === 0) {
                        const body =
                            text && text.length > 0
                                ? `📅 ${text.length > 100 ? text.slice(0, 100) + '…' : text}`
                                : '📅 A partagé une activité';
                        pushToUser(
                            p.userId,
                            {
                                title: senderName,
                                body,
                                data: { type: 'message', conversationId }
                            },
                            'message'
                        );
                    }
                }

                await Promise.all(otherParticipants.map((participant) => pushCountersToUser(participant.userId)));
            }

            return {
                command: 'share-activity',
                payload: { messages: createdMessages, failedConversationIds }
            };
        } catch (error) {
            logger.error('[Messaging] Share activity error', error);
            return { command: 'share-activity', payload: { error: 'Internal error' } };
        }
    }
);
