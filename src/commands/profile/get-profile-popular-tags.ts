import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetProfilePopularTags, WSResponse_GetProfilePopularTags } from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { getRedis, isRedisAvailable } from '@/services/redisService';
import { logger } from '@/config/logger';

const TOP_LIMIT = 20;
const CACHE_KEY = 'profile:popular-tags';
const CACHE_TTL_S = 3600; // 1 hour

async function fetchFromDb(): Promise<{ interests: string[]; skills: string[] }> {
    const db = getDatabase();

    // Group UserTag by tagId for each type, ordered by count desc
    const [interestCounts, skillCounts] = await Promise.all([
        db.userTag.groupBy({
            by: ['tagId'],
            where: { type: 'interest' },
            _count: { id: true },
            orderBy: { _count: { id: 'desc' } },
            take: TOP_LIMIT
        }),
        db.userTag.groupBy({
            by: ['tagId'],
            where: { type: 'skill' },
            _count: { id: true },
            orderBy: { _count: { id: 'desc' } },
            take: TOP_LIMIT
        })
    ]);

    const interestTagIds = interestCounts.map((r) => r.tagId);
    const skillTagIds = skillCounts.map((r) => r.tagId);
    const allIds = [...new Set([...interestTagIds, ...skillTagIds])];

    const tags = await db.tag.findMany({
        where: { id: { in: allIds } },
        select: { id: true, label: true }
    });

    const labelById = new Map(tags.map((t) => [t.id, t.label]));

    const interests = interestTagIds.map((id) => labelById.get(id)).filter((l): l is string => Boolean(l));
    const skills = skillTagIds.map((id) => labelById.get(id)).filter((l): l is string => Boolean(l));

    return { interests, skills };
}

registerCommand<WSRequest_GetProfilePopularTags>(
    'get-profile-popular-tags',
    async (_client: Client): Promise<WSResponse_GetProfilePopularTags> => {
        try {
            // Try Redis cache first
            if (isRedisAvailable()) {
                try {
                    const cached = await getRedis().get(CACHE_KEY);
                    if (cached) {
                        const parsed = JSON.parse(cached) as { interests: string[]; skills: string[] };
                        logger.debug('[Profile] Popular tags served from cache');
                        return { command: 'get-profile-popular-tags', payload: parsed };
                    }
                } catch {
                    // Cache miss or parse error — fall through to DB
                }
            }

            const result = await fetchFromDb();

            // Store in Redis for next requests
            if (isRedisAvailable()) {
                try {
                    await getRedis().set(CACHE_KEY, JSON.stringify(result), 'EX', CACHE_TTL_S);
                } catch {
                    // Non-fatal — cache write failure
                }
            }

            logger.debug(
                `[Profile] Popular tags from DB: ${result.interests.length} interests, ${result.skills.length} skills`
            );
            return { command: 'get-profile-popular-tags', payload: result };
        } catch (error) {
            logger.error('[Profile] get-profile-popular-tags error', error);
            return { command: 'get-profile-popular-tags', payload: { error: 'Internal error' } };
        }
    }
);
