import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetNotifications, WSResponse_GetNotifications } from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetNotifications>(
    'get-notifications',
    async (client: Client): Promise<WSResponse_GetNotifications> => {
        const db = getDatabase();

        try {
            const notifications = await db.notification.findMany({
                where: { userId: client.userId },
                orderBy: { createdAt: 'desc' },
                take: 50
            });

            return {
                command: 'get-notifications',
                payload: {
                    notifications: notifications.map((n) => ({
                        id: n.id,
                        type: n.type as 'match' | 'message' | 'like' | 'system',
                        title: n.title,
                        body: n.body,
                        read: n.read,
                        createdAt: n.createdAt.toISOString()
                    }))
                }
            };
        } catch (error) {
            logger.error('[Notifications] Get notifications error', error);
            return { command: 'get-notifications', payload: { error: 'Internal error' } };
        }
    }
);
