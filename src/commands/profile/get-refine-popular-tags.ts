import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type {
    WSRequest_GetRefinePopularTags,
    WSResponse_GetRefinePopularTags,
    RefinePopularTagsScope
} from '@oxyfoo/whymeet-types';
import {
    getIntention,
    getAllIntentionsForCategory,
    isIntentionCategoryKey,
    isIntentionKey
} from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { getRedis, isRedisAvailable } from '@/services/redisService';
import { logger } from '@/config/logger';

const TOP_LIMIT = 50;
const CACHE_TTL_S = 600;

function buildCacheKey(scope: RefinePopularTagsScope): string {
    if (scope.type === 'category') return `profile:refine-tags:v1:cat:${scope.categoryKey}`;
    return `profile:refine-tags:v1:int:${scope.intentionKey}`;
}

function resolveScope(scope: RefinePopularTagsScope): {
    intentionKeys: string[];
    categoryKeys: string[];
    curated: string[];
} | null {
    if (scope.type === 'intention') {
        if (!isIntentionKey(scope.intentionKey)) return null;
        const intention = getIntention(scope.intentionKey);
        return {
            intentionKeys: [intention.key],
            categoryKeys: [],
            curated: [...intention.tags]
        };
    }
    if (!isIntentionCategoryKey(scope.categoryKey)) return null;
    const intentions = getAllIntentionsForCategory(scope.categoryKey);
    const curated = new Set<string>();
    for (const i of intentions) for (const t of i.tags) curated.add(t);
    return {
        intentionKeys: intentions.map((i) => i.key),
        categoryKeys: [scope.categoryKey],
        curated: [...curated]
    };
}

async function computeTags(scope: RefinePopularTagsScope): Promise<string[]> {
    const resolved = resolveScope(scope);
    if (!resolved) return [];
    const { intentionKeys, categoryKeys, curated } = resolved;

    const db = getDatabase();

    // Find users whose profile matches the scope (by leaf intention or by category-global).
    const profiles = await db.profile.findMany({
        where: {
            OR: [
                { intentionKeys: { hasSome: intentionKeys } },
                ...(categoryKeys.length > 0 ? [{ intentionCategoryKeys: { hasSome: categoryKeys } }] : [])
            ]
        },
        select: { userId: true },
        take: 2000
    });

    const userIds = profiles.map((p) => p.userId);
    let popular: { label: string; count: number }[] = [];

    if (userIds.length > 0) {
        const grouped = await db.userTag.groupBy({
            by: ['labelNorm'],
            where: { userId: { in: userIds }, type: 'interest' },
            _count: { id: true },
            orderBy: { _count: { id: 'desc' } },
            take: TOP_LIMIT
        });

        if (grouped.length > 0) {
            const norms = grouped.map((r) => r.labelNorm);
            const rows = await db.userTag.findMany({
                where: { type: 'interest', labelNorm: { in: norms } },
                select: { label: true, labelNorm: true }
            });
            const freq = new Map<string, Map<string, number>>();
            for (const row of rows) {
                if (!freq.has(row.labelNorm)) freq.set(row.labelNorm, new Map());
                const f = freq.get(row.labelNorm)!;
                f.set(row.label, (f.get(row.label) ?? 0) + 1);
            }
            const display = new Map<string, string>();
            for (const [norm, labels] of freq) {
                let best = '';
                let bestCount = 0;
                for (const [l, c] of labels) {
                    if (c > bestCount) {
                        best = l;
                        bestCount = c;
                    }
                }
                if (best) display.set(norm, best);
            }
            popular = grouped
                .map((g) => ({ label: display.get(g.labelNorm) ?? '', count: g._count.id }))
                .filter((p) => p.label);
        }
    }

    // Merge curated suggestions and popular tags, dedup by lowercased label.
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const tag of popular.map((p) => p.label)) {
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(tag);
        if (merged.length >= TOP_LIMIT) return merged;
    }
    for (const tag of curated) {
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(tag);
        if (merged.length >= TOP_LIMIT) return merged;
    }
    return merged;
}

registerCommand<WSRequest_GetRefinePopularTags>(
    'get-refine-popular-tags',
    async (_client: Client, payload): Promise<WSResponse_GetRefinePopularTags> => {
        try {
            const scope = payload?.scope;
            if (!scope || (scope.type !== 'category' && scope.type !== 'intention')) {
                return { command: 'get-refine-popular-tags', payload: { error: 'Invalid scope' } };
            }

            const cacheKey = buildCacheKey(scope);
            if (isRedisAvailable()) {
                try {
                    const cached = await getRedis().get(cacheKey);
                    if (cached) {
                        const parsed = JSON.parse(cached) as string[];
                        return { command: 'get-refine-popular-tags', payload: { tags: parsed } };
                    }
                } catch {
                    // fall through
                }
            }

            const tags = await computeTags(scope);

            if (isRedisAvailable()) {
                try {
                    await getRedis().set(cacheKey, JSON.stringify(tags), 'EX', CACHE_TTL_S);
                } catch {
                    // non-fatal
                }
            }

            return { command: 'get-refine-popular-tags', payload: { tags } };
        } catch (error) {
            logger.error('[Profile] get-refine-popular-tags error', error);
            return { command: 'get-refine-popular-tags', payload: { error: 'Internal error' } };
        }
    }
);
