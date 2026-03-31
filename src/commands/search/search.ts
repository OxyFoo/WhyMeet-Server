import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_Search, WSResponse_Search } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { mapUserToCandidate, candidateInclude } from '@/services/userMapper';
import { logger } from '@/config/logger';

registerCommand<WSRequest_Search>('search', async (client: Client, payload): Promise<WSResponse_Search> => {
    const { filters } = payload;
    const db = getDatabase();

    try {
        // Get current user's location for distance
        const currentUser = await db.user.findUnique({
            where: { id: client.userId },
            include: { profile: { select: { latitude: true, longitude: true } } }
        });
        const myLatLng = {
            latitude: currentUser?.profile?.latitude ?? null,
            longitude: currentUser?.profile?.longitude ?? null
        };

        const where: Record<string, unknown> = { id: { not: client.userId } };

        // Exclude blocked users
        const blocks = await db.block.findMany({
            where: { OR: [{ blockerId: client.userId }, { blockedId: client.userId }] },
            select: { blockerId: true, blockedId: true }
        });
        const blockedIds = blocks.map((b) => (b.blockerId === client.userId ? b.blockedId : b.blockerId));
        if (blockedIds.length > 0) {
            where.id = { notIn: [client.userId, ...blockedIds] };
        }

        if (filters.verified) {
            where.verified = true;
        }

        if (filters.ageRange) {
            where.age = { gte: filters.ageRange[0], lte: filters.ageRange[1] };
        }

        if (filters.query) {
            where.OR = [
                { name: { contains: filters.query, mode: 'insensitive' } },
                { profile: { bio: { contains: filters.query, mode: 'insensitive' } } }
            ];
        }

        if (filters.intentions && filters.intentions.length > 0) {
            where.profile = {
                ...((where.profile as Record<string, unknown>) ?? {}),
                intentions: { hasSome: filters.intentions }
            };
        }

        if (filters.tags && filters.tags.length > 0) {
            where.tags = {
                some: { tag: { label: { in: filters.tags } } }
            };
        }

        const users = await db.user.findMany({
            where,
            include: candidateInclude,
            take: 50
        });

        const targetIntentions = filters.intentions ?? [];
        const results = users
            .map((u) => {
                const candidate = mapUserToCandidate(u, targetIntentions, myLatLng);
                const matchCount = targetIntentions.length
                    ? candidate.intentions.filter((i) => targetIntentions.includes(i)).length
                    : 0;
                return { candidate, matchCount };
            })
            .sort((a, b) => b.matchCount - a.matchCount)
            .map((r) => r.candidate);

        logger.debug(`[Search] ${results.length} results for user: ${client.userId}`);
        return { command: 'search', payload: { results } };
    } catch (error) {
        logger.error('[Search] Search error', error);
        return { command: 'search', payload: { error: 'Internal error' } };
    }
});
