import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetBlockedUsers, WSResponse_GetBlockedUsers } from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetBlockedUsers>(
    'get-blocked-users',
    async (client: Client, _payload): Promise<WSResponse_GetBlockedUsers> => {
        const db = getDatabase();

        try {
            const blocks = await db.block.findMany({
                where: { blockerId: client.userId },
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
                orderBy: { createdAt: 'desc' }
            });

            const blockedUsers = blocks.map((b) => ({
                id: b.id,
                user: {
                    id: b.blocked.id,
                    name: b.blocked.name,
                    photoKey: b.blocked.photos[0]?.key
                },
                blockedAt: b.createdAt.toISOString()
            }));

            return { command: 'get-blocked-users', payload: { blockedUsers } };
        } catch (error) {
            logger.error('[Moderation] Get blocked users error', error);
            return { command: 'get-blocked-users', payload: { error: 'Internal error' } };
        }
    }
);
