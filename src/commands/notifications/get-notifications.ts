import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetNotifications, WSResponse_GetNotifications } from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { decodeCursor, encodeCursor, resolveLimit } from '@/services/cursorPagination';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetNotifications>(
    'get-notifications',
    async (client: Client, payload): Promise<WSResponse_GetNotifications> => {
        const db = getDatabase();

        try {
            const limit = resolveLimit(payload?.limit);
            const decoded = decodeCursor(payload?.cursor);

            const cursorFilter = decoded
                ? {
                      OR: [
                          { createdAt: { lt: new Date(decoded.k) } },
                          {
                              AND: [{ createdAt: new Date(decoded.k) }, { id: { lt: decoded.i } }]
                          }
                      ]
                  }
                : undefined;

            const rows = await db.notification.findMany({
                where: { userId: client.userId, ...(cursorFilter ?? {}) },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: limit + 1
            });

            const hasMore = rows.length > limit;
            const sliced = hasMore ? rows.slice(0, limit) : rows;
            const last = sliced[sliced.length - 1];
            const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

            return {
                command: 'get-notifications',
                payload: {
                    notifications: sliced.map((n) => ({
                        id: n.id,
                        type: n.type as 'match' | 'message' | 'like' | 'system',
                        title: n.title,
                        body: n.body,
                        read: n.read,
                        createdAt: n.createdAt.toISOString()
                    })),
                    nextCursor
                }
            };
        } catch (error) {
            logger.error('[Notifications] Get notifications error', error);
            return { command: 'get-notifications', payload: { error: 'Internal error' } };
        }
    }
);
