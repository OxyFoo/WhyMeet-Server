import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetPopularTags, WSResponse_GetPopularTags, IntentionKey } from '@oxyfoo/whymeet-types';
import { SUB_INTENTIONS } from '@oxyfoo/whymeet-types';
import { buildPipelineContext, runPipelineQuery } from '@/services/discoveryPipeline';
import { getDatabase } from '@/services/database';
import { getRedis, isRedisAvailable } from '@/services/redisService';
import { logger } from '@/config/logger';

const TOP_TAGS_LIMIT = 20;
const CACHE_TTL_S = 600; // 10 minutes — viewer-context dependent

function buildCacheKey(userId: string, intention: IntentionKey, subCategories: string[]): string {
    const subsHash = [...subCategories].sort().join(',');
    return `discovery:popular-tags:${userId}:${intention}:${subsHash}`;
}

async function computePopularTags(client: Client, intention: IntentionKey, subCategories: string[]): Promise<string[]> {
    const subs = SUB_INTENTIONS[intention] ?? [];

    // Determine scope: tags from selected sub-categories (or all subs if none selected)
    const filteredSubs = subCategories.length > 0 ? subs.filter((s) => subCategories.includes(s.key)) : subs;
    const scopeTags = [...new Set(filteredSubs.flatMap((s) => s.tags))];

    if (scopeTags.length === 0) {
        return [];
    }

    const setup = await buildPipelineContext(client);
    const { qualified } = await runPipelineQuery(setup, { intentions: [intention], tags: scopeTags }, 500);

    // Fallback: no candidates → return static scope tags as-is
    if (qualified.length === 0) {
        return scopeTags.slice(0, TOP_TAGS_LIMIT);
    }

    const qualifiedIds = qualified.map((q) => q.user.id);

    const db = getDatabase();
    const tagCountsRaw = await db.userTag.findMany({
        where: { userId: { in: qualifiedIds } },
        select: { tagId: true }
    });

    const countMap = new Map<string, number>();
    for (const { tagId } of tagCountsRaw) {
        countMap.set(tagId, (countMap.get(tagId) ?? 0) + 1);
    }

    const tagIds = [...countMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_TAGS_LIMIT)
        .map(([id]) => id);

    if (tagIds.length === 0) {
        return scopeTags.slice(0, TOP_TAGS_LIMIT);
    }

    const tags = await db.tag.findMany({
        where: { id: { in: tagIds } },
        select: { id: true, label: true }
    });

    const labelById = new Map(tags.map((t) => [t.id, t.label]));
    return tagIds.map((id) => labelById.get(id)).filter((l): l is string => l !== undefined);
}

registerCommand<WSRequest_GetPopularTags>(
    'get-popular-tags',
    async (client: Client, payload): Promise<WSResponse_GetPopularTags> => {
        try {
            const { intention, subCategories } = payload;
            const cacheKey = buildCacheKey(client.userId, intention, subCategories);

            // Try Redis cache
            if (isRedisAvailable()) {
                try {
                    const cached = await getRedis().get(cacheKey);
                    if (cached) {
                        const parsed = JSON.parse(cached) as string[];
                        logger.debug(`[Discovery] Popular tags served from cache for ${client.userId} / ${intention}`);
                        return { command: 'get-popular-tags', payload: { tags: parsed } };
                    }
                } catch {
                    // Cache miss or parse error — fall through to DB
                }
            }

            const orderedLabels = await computePopularTags(client, intention, subCategories);

            // Store in cache (non-blocking)
            if (isRedisAvailable()) {
                try {
                    await getRedis().set(cacheKey, JSON.stringify(orderedLabels), 'EX', CACHE_TTL_S);
                } catch {
                    // Non-fatal cache write failure
                }
            }

            logger.debug(
                `[Discovery] Popular tags for ${client.userId} / ${intention}: ${orderedLabels.length} tags (from DB)`
            );
            return { command: 'get-popular-tags', payload: { tags: orderedLabels } };
        } catch (error) {
            logger.error('[Discovery] Get popular tags error', error);
            return { command: 'get-popular-tags', payload: { error: 'Internal error' } };
        }
    }
);
