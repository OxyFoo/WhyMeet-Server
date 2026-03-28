import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetConversations, WSResponse_GetConversations } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetConversations>(
    'get-conversations',
    async (client: Client): Promise<WSResponse_GetConversations> => {
        const db = getDatabase();

        try {
            const participations = await db.conversationParticipant.findMany({
                where: { userId: client.userId },
                include: {
                    conversation: {
                        include: {
                            participants: {
                                where: { userId: { not: client.userId } },
                                include: { user: true }
                            },
                            messages: {
                                orderBy: { timestamp: 'desc' },
                                take: 1
                            }
                        }
                    }
                }
            });

            const conversations = participations.map((p) => {
                const other = p.conversation.participants[0]?.user;
                const lastMsg = p.conversation.messages[0];
                return {
                    id: p.conversation.id,
                    participant: other
                        ? {
                              id: other.id,
                              name: other.name,
                              age: other.age,
                              avatar: other.avatar,
                              city: other.city,
                              verified: other.verified
                          }
                        : { id: '', name: 'Unknown', age: 0, avatar: '', city: '', verified: false },
                    lastMessage: lastMsg?.text,
                    lastMessageTime: lastMsg?.timestamp.toISOString(),
                    unreadCount: p.unreadCount
                };
            });

            return { command: 'get-conversations', payload: { conversations } };
        } catch (error) {
            logger.error('[Messaging] Get conversations error', error);
            return { command: 'get-conversations', payload: { error: 'Internal error' } };
        }
    }
);
