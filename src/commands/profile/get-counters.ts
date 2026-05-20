/**
 * @file get-counters.ts
 * @description Returns lightweight aggregated counters used by the mobile
 * UI to power badges (inbox unread, pending match requests, unread
 * notifications). Kept intentionally cheap (three `COUNT(*)`) so the
 * client can refresh it eagerly without hammering the paginated list
 * endpoints.
 */

import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetCounters, WSResponse_GetCounters } from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetCounters>('get-counters', async (client: Client): Promise<WSResponse_GetCounters> => {
    const db = getDatabase();

    try {
        const [unreadAggregate, pendingMatchRequests, unreadNotifications] = await Promise.all([
            db.conversationParticipant.aggregate({
                where: { userId: client.userId },
                _sum: { unreadCount: true }
            }),
            db.match.count({
                where: {
                    receiverId: client.userId,
                    category: 'like',
                    mutual: false,
                    sender: { banned: false, suspended: false, deleted: false }
                }
            }),
            db.notification.count({
                where: { userId: client.userId, read: false }
            })
        ]);

        return {
            command: 'get-counters',
            payload: {
                counters: {
                    unreadConversations: unreadAggregate._sum.unreadCount ?? 0,
                    pendingMatchRequests,
                    unreadNotifications
                }
            }
        };
    } catch (error) {
        logger.error('[Counters] Get counters error', error);
        return { command: 'get-counters', payload: { error: 'Internal error' } };
    }
});
