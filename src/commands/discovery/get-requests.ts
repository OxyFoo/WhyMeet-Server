import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetRequests, WSResponse_GetRequests, IntentionKey } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetRequests>('get-requests', async (client: Client): Promise<WSResponse_GetRequests> => {
    const db = getDatabase();

    try {
        // Get likes/stars received that are NOT mutual (i.e. pending requests)
        const receivedMatches = await db.match.findMany({
            where: {
                receiverId: client.userId,
                category: 'like',
                mutual: false
            },
            include: {
                sender: {
                    include: { profile: true }
                }
            },
            orderBy: { matchedAt: 'desc' }
        });

        // Exclude ones where the current user has already acted (liked or skipped the sender)
        const actedOn = await db.match.findMany({
            where: { senderId: client.userId },
            select: { receiverId: true }
        });
        const actedOnIds = new Set(actedOn.map((m) => m.receiverId));

        const requests = receivedMatches
            .filter((m) => !actedOnIds.has(m.senderId))
            .map((m) => ({
                id: m.id,
                sender: {
                    id: m.sender.id,
                    name: m.sender.name,
                    age: m.sender.age,
                    avatar: m.sender.avatar,
                    city: m.sender.city,
                    verified: m.sender.verified
                },
                intentions: (m.sender.profile?.intentions ?? []) as IntentionKey[],
                matchContext: m.matchContext,
                sentAt: m.matchedAt.toISOString()
            }));

        logger.debug(`[Discovery] ${requests.length} requests for user: ${client.userId}`);
        return { command: 'get-requests', payload: { requests } };
    } catch (error) {
        logger.error('[Discovery] Get requests error', error);
        return { command: 'get-requests', payload: { error: 'Internal error' } };
    }
});
