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
import { getPremiumUserIds } from '@/services/subscriptionService';
import { getBoostedUserIds } from '@/services/boostService';
import { logger } from '@/config/logger';
import { safeDecryptText } from '@/services/messageEncryption';
import { decodeCursor, paginateCursor, resolveLimit } from '@/services/cursorPagination';

type UserWithPhotos = Prisma.UserGetPayload<{ include: { photos: true } }>;

function mapUser(u: UserWithPhotos, flags?: { isPremium?: boolean; isBoosted?: boolean }) {
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
        isPremium: flags?.isPremium ?? false,
        isBoosted: flags?.isBoosted ?? false,
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
    async (client: Client, payload): Promise<WSResponse_GetConversations> => {
        const db = getDatabase();
        const limit = resolveLimit(payload?.limit);
        const decoded = decodeCursor(payload?.cursor);

        try {
            // Keyset pagination on `(lastMessageAt, id) DESC`. When no cursor
            // is given we simply take the newest `limit + 1` rows.
            const cursorFilter: Prisma.ConversationWhereInput | undefined = decoded
                ? {
                      OR: [
                          { lastMessageAt: { lt: new Date(decoded.k) } },
                          {
                              AND: [{ lastMessageAt: new Date(decoded.k) }, { id: { lt: decoded.i } }]
                          }
                      ]
                  }
                : undefined;

            const rows = await db.conversation.findMany({
                where: {
                    participants: { some: { userId: client.userId } },
                    ...(cursorFilter ?? {})
                },
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
                },
                orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
                take: limit + 1
            });

            // Drop conversations whose only other participant is unavailable
            // (banned/suspended/deleted). Group conversations always pass.
            const visible = rows.filter((conv) => {
                if (conv.isGroup) return true;
                const other = conv.participants.find((pp) => pp.userId !== client.userId)?.user;
                return !other || (!other.banned && !other.suspended && !other.deleted);
            });

            const otherIds = visible.flatMap((conv) =>
                conv.participants.filter((pp) => pp.userId !== client.userId).map((pp) => pp.userId)
            );
            const [premiumIds, boostedIds] = await Promise.all([getPremiumUserIds(otherIds), getBoostedUserIds()]);
            const flagsFor = (userId: string) => ({
                isPremium: premiumIds.has(userId),
                isBoosted: boostedIds.has(userId)
            });

            const page = paginateCursor(
                visible,
                limit,
                (conv) => conv.lastMessageAt,
                (conv) => conv.id,
                (conv): Conversation => {
                    const lastMsg = conv.messages[0];
                    const isGroup = conv.isGroup;

                    const myParticipation = conv.participants.find((pp) => pp.userId === client.userId);

                    const base = {
                        id: conv.id,
                        lastMessage:
                            lastMsg?.type === 'text' || lastMsg?.type === 'shared_activity'
                                ? safeDecryptText(lastMsg.text)
                                : lastMsg?.text,
                        lastMessageTime: lastMsg?.timestamp.toISOString(),
                        lastMessageType: lastMsg ? ((lastMsg.type ?? 'text') as MessageType) : undefined,
                        lastMessageSenderId: lastMsg?.senderId,
                        unreadCount: myParticipation?.unreadCount ?? 0,
                        isGroup
                    };

                    if (isGroup) {
                        const others = conv.participants
                            .filter((pp) => pp.userId !== client.userId)
                            .map((pp) => mapUser(pp.user, flagsFor(pp.userId)));
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
                        participant: other ? mapUser(other, flagsFor(other.id)) : UNKNOWN_USER
                    };
                }
            );

            return {
                command: 'get-conversations',
                payload: { conversations: page.items, nextCursor: page.nextCursor }
            };
        } catch (error) {
            logger.error('[Messaging] Get conversations error', error);
            return { command: 'get-conversations', payload: { error: 'Internal error' } };
        }
    }
);
