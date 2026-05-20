import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type {
    WSRequest_GetRequests,
    WSResponse_GetRequests,
    Gender,
    PreferredPeriod,
    ProfilePhoto,
    IntentionKey,
    IntentionCategoryKey
} from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { computeAge } from '@/services/userMapper';
import { isPremium } from '@/services/subscriptionService';
import { decodeCursor, encodeCursor, resolveLimit } from '@/services/cursorPagination';
import { getHiddenIncomingRequestSenderIds, incomingRequestVisibilityFilter } from '@/services/matchRequestVisibility';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetRequests>(
    'get-requests',
    async (client: Client, payload): Promise<WSResponse_GetRequests> => {
        const db = getDatabase();

        try {
            const limit = resolveLimit(payload?.limit);
            const decoded = decodeCursor(payload?.cursor);

            const hiddenRequestSenderIds = await getHiddenIncomingRequestSenderIds(client.userId);

            const cursorFilter = decoded
                ? {
                      OR: [
                          { matchedAt: { lt: new Date(decoded.k) } },
                          {
                              AND: [{ matchedAt: new Date(decoded.k) }, { id: { lt: decoded.i } }]
                          }
                      ]
                  }
                : undefined;

            const [receivedMatches, userIsPremium] = await Promise.all([
                db.match.findMany({
                    where: {
                        receiverId: client.userId,
                        category: 'like',
                        mutual: false,
                        sender: {
                            banned: false,
                            suspended: false,
                            deleted: false
                        },
                        ...incomingRequestVisibilityFilter(hiddenRequestSenderIds),
                        ...(cursorFilter ?? {})
                    },
                    include: {
                        sender: {
                            include: {
                                profile: true,
                                photos: { orderBy: { position: 'asc' } }
                            }
                        }
                    },
                    orderBy: [{ matchedAt: 'desc' }, { id: 'desc' }],
                    take: limit + 1
                }),
                isPremium(client.userId)
            ]);

            const hasMore = receivedMatches.length > limit;
            const sliced = hasMore ? receivedMatches.slice(0, limit) : receivedMatches;
            const last = sliced[sliced.length - 1];
            const nextCursor = hasMore && last ? encodeCursor(last.matchedAt, last.id) : null;

            const requests = sliced.map((m) => ({
                id: m.id,
                sender: {
                    id: m.sender.id,
                    name: m.sender.name,
                    age: computeAge(m.sender.birthDate),
                    birthDate: m.sender.birthDate?.toISOString() ?? null,
                    gender: (m.sender.gender || 'male') as Gender,
                    photos: (m.sender.photos ?? []).map((p) => ({
                        id: p.id,
                        key: userIsPremium ? p.key : p.keyBlurred,
                        description: p.description,
                        position: p.position
                    })) as ProfilePhoto[],
                    city: m.sender.city,
                    verified: m.sender.verified,
                    suspended: m.sender.suspended ?? false,
                    banned: m.sender.banned ?? false,
                    preferredPeriod: (m.sender.preferredPeriod ?? 'any') as PreferredPeriod,
                    isPremium: false,
                    isBoosted: false,
                    badges: []
                },
                intentionKeys: (m.sender.profile?.intentionKeys ?? []) as IntentionKey[],
                categoryKey: (m.categoryKey || undefined) as IntentionCategoryKey | undefined,
                intentionKey: (m.intentionKey || undefined) as IntentionKey | undefined,
                matchContext: m.matchContext,
                sentAt: m.matchedAt.toISOString()
            }));

            logger.debug(`[Discovery] ${requests.length} requests for user: ${client.userId}`);
            return { command: 'get-requests', payload: { requests, nextCursor } };
        } catch (error) {
            logger.error('[Discovery] Get requests error', error);
            return { command: 'get-requests', payload: { error: 'Internal error' } };
        }
    }
);
