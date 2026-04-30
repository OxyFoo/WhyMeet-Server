import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type {
    WSRequest_GetConversations,
    WSResponse_GetConversations,
    Conversation,
    Gender,
    PreferredPeriod,
    ProfilePhoto,
    MessageType
} from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import type { Prisma } from '@prisma/client';
import { computeAge } from '@/services/userMapper';
import { logger } from '@/config/logger';

type UserWithPhotos = Prisma.UserGetPayload<{ include: { photos: true } }>;

function mapUser(u: UserWithPhotos) {
    return {
        id: u.id,
        name: u.name,
        age: computeAge(u.birthDate),
        birthDate: u.birthDate?.toISOString() ?? null,
        gender: (u.gender || 'male') as Gender,
        photos: (u.photos ?? []).map((p) => ({
            id: p.id,
            key: p.key,
            description: p.description,
            position: p.position
        })),
        city: u.city,
        verified: u.verified,
        suspended: u.suspended ?? false,
        banned: u.banned ?? false,
        preferredPeriod: (u.preferredPeriod ?? 'any') as PreferredPeriod,
        isPremium: false,
        isBoosted: false,
        badges: []
    };
}

const UNKNOWN_USER = {
    id: '',
    name: 'Unknown',
    age: 0,
    birthDate: null,
    gender: 'male' as Gender,
    photos: [] as ProfilePhoto[],
    city: '',
    verified: false,
    suspended: false,
    banned: false,
    preferredPeriod: 'any' as PreferredPeriod,
    isPremium: false,
    isBoosted: false,
    badges: []
};

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
                                include: { user: { include: { photos: { orderBy: { position: 'asc' } } } } }
                            },
                            messages: {
                                orderBy: { timestamp: 'desc' },
                                take: 1
                            },
                            activity: {
                                select: { id: true, title: true, isCancelled: true }
                            }
                        }
                    }
                }
            });

            const conversations: Conversation[] = participations
                .filter((p) => {
                    if (p.conversation.isGroup) return true;
                    const other = p.conversation.participants.find((pp) => pp.userId !== client.userId)?.user;
                    return !other || (!other.banned && !other.suspended && !other.deleted);
                })
                .map((p) => {
                    const conv = p.conversation;
                    const lastMsg = conv.messages[0];
                    const isGroup = conv.isGroup;

                    const base = {
                        id: conv.id,
                        lastMessage: lastMsg?.text,
                        lastMessageTime: lastMsg?.timestamp.toISOString(),
                        lastMessageType: lastMsg ? ((lastMsg.type ?? 'text') as MessageType) : undefined,
                        lastMessageSenderId: lastMsg?.senderId,
                        unreadCount: p.unreadCount,
                        isGroup
                    };

                    if (isGroup) {
                        const others = conv.participants
                            .filter((pp) => pp.userId !== client.userId)
                            .map((pp) => mapUser(pp.user));
                        return {
                            ...base,
                            participant: others[0] ?? UNKNOWN_USER,
                            participants: others,
                            activityId: conv.activity?.id,
                            activityTitle: conv.activity?.title,
                            participantCount: conv.participants.length
                        };
                    }

                    const other = conv.participants.find((pp) => pp.userId !== client.userId)?.user;
                    return {
                        ...base,
                        participant: other ? mapUser(other) : UNKNOWN_USER
                    };
                });

            conversations.sort((a, b) => {
                const dateA = a.lastMessageTime ? new Date(a.lastMessageTime).getTime() : 0;
                const dateB = b.lastMessageTime ? new Date(b.lastMessageTime).getTime() : 0;
                return dateB - dateA;
            });

            return { command: 'get-conversations', payload: { conversations } };
        } catch (error) {
            logger.error('[Messaging] Get conversations error', error);
            return { command: 'get-conversations', payload: { error: 'Internal error' } };
        }
    }
);
