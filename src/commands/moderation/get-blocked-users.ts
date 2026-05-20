import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetBlockedUsers, WSResponse_GetBlockedUsers } from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';
import { decodeCursor, encodeCursor, resolveLimit } from '@/services/cursorPagination';

registerCommand<WSRequest_GetBlockedUsers>(
    'get-blocked-users',
    async (client: Client, payload): Promise<WSResponse_GetBlockedUsers> => {
        const db = getDatabase();
        const limit = resolveLimit(payload?.limit);
        const decoded = decodeCursor(payload?.cursor);

        try {
            const blocks = await db.block.findMany({
                where: {
                    blockerId: client.userId,
                    ...(decoded && {
                        OR: [
                            { createdAt: { lt: new Date(decoded.k) } },
                            { AND: [{ createdAt: new Date(decoded.k) }, { id: { lt: decoded.i } }] }
                        ]
                    })
                },
                include: {
                    blocked: {
                        select: {
                            id: true,
                            name: true,
                            photos: {
                                select: { key: true },
                                take: 1,
                                orderBy: { position: 'asc' }
                            }
                        }
                    }
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: limit + 1
            });

            const hasMore = blocks.length > limit;
            const sliced = hasMore ? blocks.slice(0, limit) : blocks;
            const last = sliced[sliced.length - 1];
            const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

            const blockedUsers = sliced.map((b) => ({
                id: b.id,
                user: {
                    id: b.blocked.id,
                    name: b.blocked.name,
                    photoKey: b.blocked.photos[0]?.key
                },
                blockedAt: b.createdAt.toISOString()
            }));

            return { command: 'get-blocked-users', payload: { blockedUsers, nextCursor } };
        } catch (error) {
            logger.error('[Moderation] Get blocked users error', error);
            return { command: 'get-blocked-users', payload: { error: 'Internal error' } };
        }
    }
);
