import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type {
    IntentionSelection,
    WSRequest_GetIntentionPopularTags,
    WSResponse_GetIntentionPopularTags
} from '@oxyfoo/whymeet-types';
import { getIntention } from '@oxyfoo/whymeet-types';
import { buildPipelineContext, runPipelineQuery } from '@/services/discoveryPipeline';
import { validateOptionalSelectedTags, validateIntentionSelection } from '@/config/validation';
import { getDatabase } from '@/services/database';
import { getRedis, isRedisAvailable } from '@/services/redisService';
import { normalizeActiveIntentionSelection } from '@/services/intentionKeys';
import { logger } from '@/config/logger';

const TOP_TAGS_LIMIT = 20;
const CACHE_TTL_S = 600;

function buildCacheKey(userId: string, intentionKey: string, selectedTags: string[]): string {
    const selectedHash = [...selectedTags].sort().join(',');
    return `discovery:intention-tags:v1:${userId}:${intentionKey}:${selectedHash}`;
}

async function computePopularTags(
    client: Client,
    selection: IntentionSelection,
    selectedTags: string[]
): Promise<string[]> {
    const intention = getIntention(selection.intentionKey);
    const scopeTags = [...new Set([...(selectedTags.length > 0 ? selectedTags : intention.tags)])];
    if (scopeTags.length === 0) return [];

    const setup = await buildPipelineContext(client);
    const { qualified } = await runPipelineQuery(
        setup,
        {
            categoryKey: selection.categoryKey,
            intentionKey: selection.intentionKey,
            tags: scopeTags
        },
        500
    );

    if (qualified.length === 0) {
        return scopeTags.slice(0, TOP_TAGS_LIMIT);
    }

    const qualifiedIds = qualified.map((q) => q.user.id);
    const scopeLowers = new Set(scopeTags.map((label) => label.toLowerCase()));
    const tagRows = await getDatabase().userTag.findMany({
        where: { userId: { in: qualifiedIds }, labelLower: { in: [...scopeLowers] } },
        select: { label: true, labelLower: true }
    });

    const countMap = new Map<string, number>();
    const displayByLower = new Map<string, string>();
    for (const { label, labelLower } of tagRows) {
        countMap.set(labelLower, (countMap.get(labelLower) ?? 0) + 1);
        if (!displayByLower.has(labelLower)) displayByLower.set(labelLower, label);
    }

    const ordered = [...countMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_TAGS_LIMIT)
        .map(([lower]) => displayByLower.get(lower))
        .filter((label): label is string => Boolean(label));

    if (ordered.length === 0) return scopeTags.slice(0, TOP_TAGS_LIMIT);

    const scopeByLower = new Map(scopeTags.map((label) => [label.toLowerCase(), label]));
    return ordered.map((label) => scopeByLower.get(label.toLowerCase()) ?? label);
}

registerCommand<WSRequest_GetIntentionPopularTags>(
    'get-intention-popular-tags',
    async (client: Client, payload): Promise<WSResponse_GetIntentionPopularTags> => {
        try {
            const selectionError = validateIntentionSelection(payload.selection);
            if (selectionError) return { command: 'get-intention-popular-tags', payload: { error: selectionError } };
            const tagsError = validateOptionalSelectedTags(payload.selectedTags);
            if (tagsError) return { command: 'get-intention-popular-tags', payload: { error: tagsError } };

            const selection = normalizeActiveIntentionSelection(payload.selection);
            if (!selection)
                return { command: 'get-intention-popular-tags', payload: { error: 'Invalid intention selection' } };

            const cacheKey = buildCacheKey(
                client.userId,
                selection.intentionKey,
                payload.selectedTags ?? selection.tags ?? []
            );
            if (isRedisAvailable()) {
                try {
                    const cached = await getRedis().get(cacheKey);
                    if (cached) {
                        const parsed = JSON.parse(cached) as string[];
                        logger.debug(
                            `[Discovery] Intention tags served from cache for ${client.userId} / ${selection.intentionKey}`
                        );
                        return { command: 'get-intention-popular-tags', payload: { tags: parsed } };
                    }
                } catch {
                    // Cache miss or parse error; compute from DB.
                }
            }

            const tags = await computePopularTags(client, selection, payload.selectedTags ?? selection.tags ?? []);
            if (isRedisAvailable()) {
                try {
                    await getRedis().set(cacheKey, JSON.stringify(tags), 'EX', CACHE_TTL_S);
                } catch {
                    // Non-fatal cache write failure.
                }
            }

            logger.debug(
                `[Discovery] Intention tags for ${client.userId} / ${selection.intentionKey}: ${tags.length} tags`
            );
            return { command: 'get-intention-popular-tags', payload: { tags } };
        } catch (error) {
            logger.error('[Discovery] Get intention popular tags error', error);
            return { command: 'get-intention-popular-tags', payload: { error: 'Internal error' } };
        }
    }
);
