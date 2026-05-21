import type { UserCounters } from '@oxyfoo/whymeet-types';
import { logger } from '@/config/logger';
import { getClientsForUser } from '@/server/Server';
import { getDatabase } from './database';
import { getHiddenIncomingRequestSenderIds, incomingRequestVisibilityFilter } from './matchRequestVisibility';

export async function getUserCounters(userId: string): Promise<UserCounters> {
    const db = getDatabase();

    const [unreadAggregate, unreadNotifications, hiddenRequestSenderIds] = await Promise.all([
        db.conversationParticipant.aggregate({
            where: { userId },
            _sum: { unreadCount: true }
        }),
        db.notification.count({
            where: { userId, read: false }
        }),
        getHiddenIncomingRequestSenderIds(userId)
    ]);

    const pendingMatchRequests = await db.match.count({
        where: {
            receiverId: userId,
            category: 'like',
            mutual: false,
            sender: { banned: false, suspended: false, deleted: false, underageDeclared: false },
            ...incomingRequestVisibilityFilter(hiddenRequestSenderIds)
        }
    });

    return {
        unreadConversations: unreadAggregate._sum.unreadCount ?? 0,
        pendingMatchRequests,
        unreadNotifications
    };
}

export async function pushCountersToUser(userId: string): Promise<void> {
    const clients = getClientsForUser(userId);
    if (clients.length === 0) return;

    try {
        const counters = await getUserCounters(userId);
        for (const client of clients) {
            client.send({ event: 'counters', payload: { counters } });
        }
    } catch (error) {
        logger.warn(`[Counters] Failed to push counters for user ${userId}`, error);
    }
}
