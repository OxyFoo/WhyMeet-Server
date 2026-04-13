import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type {
    WSRequest_GetConversations,
    WSResponse_GetConversations,
    Gender,
    PreferredPeriod,
    ProfilePhoto
} from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { computeAge } from '@/services/userMapper';
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
                                include: { user: { include: { photos: { orderBy: { position: 'asc' } } } } }
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
                              age: computeAge(other.birthDate),
                              birthDate: other.birthDate?.toISOString() ?? null,
                              gender: (other.gender || 'male') as Gender,
                              photos: (other.photos ?? []).map((p) => ({
                                  id: p.id,
                                  key: p.key,
                                  description: p.description,
                                  position: p.position
                              })) as ProfilePhoto[],
                              city: other.city,
                              verified: other.verified,
                              preferredPeriod: (other.preferredPeriod ?? 'any') as PreferredPeriod,
                              isPremium: false,
                              isBoosted: false
                          }
                        : {
                              id: '',
                              name: 'Unknown',
                              age: 0,
                              birthDate: null,
                              gender: 'male' as Gender,
                              photos: [] as ProfilePhoto[],
                              city: '',
                              verified: false,
                              preferredPeriod: 'any' as PreferredPeriod,
                              isPremium: false,
                              isBoosted: false
                          },
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
