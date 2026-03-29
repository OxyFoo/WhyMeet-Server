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
        const where: Record<string, unknown> = { id: { not: client.userId } };

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

        if (filters.intention) {
            where.profile = {
                ...((where.profile as Record<string, unknown>) ?? {}),
                intentions: { has: filters.intention }
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

        const results = users.map((u) => mapUserToCandidate(u, filters.intention));

        logger.debug(`[Search] ${results.length} results for user: ${client.userId}`);
        return { command: 'search', payload: { results } };
    } catch (error) {
        logger.error('[Search] Search error', error);
        return { command: 'search', payload: { error: 'Internal error' } };
    }
});
