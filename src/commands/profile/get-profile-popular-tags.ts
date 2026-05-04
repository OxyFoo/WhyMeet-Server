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

    // Group UserTag by labelNorm (robust normalized form, accent-insensitive).
    // This catches variants (JS, javascript, Java Script) as one cluster, then
    // selects the most-frequent display label per cluster.
    const [interestCounts, skillCounts] = await Promise.all([
        db.userTag.groupBy({
            by: ['labelNorm'],
            where: { type: 'interest' },
            _count: { id: true },
            orderBy: { _count: { id: 'desc' } },
            take: TOP_LIMIT
        }),
        db.userTag.groupBy({
            by: ['labelNorm'],
            where: { type: 'skill' },
            _count: { id: true },
            orderBy: { _count: { id: 'desc' } },
            take: TOP_LIMIT
        })
    ]);

    // For each normalized cluster, find the most-frequent display label.
    async function resolveDisplayLabels(labelNorms: string[], type: 'interest' | 'skill') {
        if (labelNorms.length === 0) return new Map<string, string>();
        const rows = await db.userTag.findMany({
            where: { type, labelNorm: { in: labelNorms } },
            select: { label: true, labelNorm: true }
        });

        // Group by labelNorm, count label frequencies
        const clusterMap = new Map<string, Map<string, number>>();
        for (const row of rows) {
            if (!clusterMap.has(row.labelNorm)) {
                clusterMap.set(row.labelNorm, new Map());
            }
            const freq = clusterMap.get(row.labelNorm)!;
            freq.set(row.label, (freq.get(row.label) ?? 0) + 1);
        }

        // Pick most-frequent label per cluster
        const result = new Map<string, string>();
        for (const [labelNorm, freq] of clusterMap) {
            let bestLabel = '';
            let bestCount = 0;
            for (const [label, count] of freq) {
                if (count > bestCount) {
                    bestLabel = label;
                    bestCount = count;
                }
            }
            if (bestLabel) result.set(labelNorm, bestLabel);
        }
        return result;
    }

    const [interestLabels, skillLabels] = await Promise.all([
        resolveDisplayLabels(
            interestCounts.map((r) => r.labelNorm),
            'interest'
        ),
        resolveDisplayLabels(
            skillCounts.map((r) => r.labelNorm),
            'skill'
        )
    ]);

    const interests = interestCounts.map((r) => interestLabels.get(r.labelNorm)).filter((l): l is string => Boolean(l));
    const skills = skillCounts.map((r) => skillLabels.get(r.labelNorm)).filter((l): l is string => Boolean(l));

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
