import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { MatchCandidate, WSRequest_Search, WSResponse_Search } from '@oxyfoo/whymeet-types';
import { runDiscoveryPipeline } from '@/services/discoveryPipeline';
import { mapUserToCandidate } from '@/services/userMapper';
import { getSearchQuota } from '@/services/searchQuotaService';
import { getBoostedUserIds } from '@/services/boostService';
import { interleaveByBoost } from '@/services/interleaveResults';
import { validateSearchFilters } from '@/config/validation';
import { logger } from '@/config/logger';
import { enrichProfileIntentionsFromFilters } from '@/services/intentionProfileEnrichment';

const MAX_RESULTS = 25;

function addRandomness(candidates: MatchCandidate[]): MatchCandidate[] {
    return candidates
        .map((candidate) => ({ candidate, sortKey: (candidate.score ?? 0) + (Math.random() - 0.5) * 20 }))
        .sort((a, b) => b.sortKey - a.sortKey)
        .map((entry) => entry.candidate);
}

registerCommand<WSRequest_Search>('search', async (client: Client, payload): Promise<WSResponse_Search> => {
    const { filters } = payload;

    try {
        const validationError = validateSearchFilters(filters);
        if (validationError) return { command: 'search', payload: { error: validationError } };

        const { qualified, ctx } = await runDiscoveryPipeline(client, filters, 1000);
        await enrichProfileIntentionsFromFilters(client.userId, filters);
        const results = qualified.map((candidateScore) => {
            const candidate = mapUserToCandidate(candidateScore.user, ctx.prefIntentionKeys, ctx.myLatLng);
            candidate.score = candidateScore.score;
            candidate.intentionMatch = candidateScore.intentionMatch;
            return candidate;
        });

        const boostedIds = await getBoostedUserIds();
        const interleaved = interleaveByBoost(results, boostedIds);
        const totalCount = interleaved.length;
        const shuffled = addRandomness(interleaved).slice(0, MAX_RESULTS);
        const quota = await getSearchQuota(client.userId);

        logger.debug(`[Search] ${shuffled.length}/${totalCount} results for user: ${client.userId}`);
        return { command: 'search', payload: { results: shuffled, remaining: quota.remaining, totalCount } };
    } catch (error) {
        logger.error('[Search] Search error', error);
        return { command: 'search', payload: { error: 'Internal error' } };
    }
});
