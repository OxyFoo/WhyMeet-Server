import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_SearchWithToken, WSResponse_SearchWithToken, MatchCandidate } from '@oxyfoo/whymeet-types';
import { mapUserToCandidate } from '@/services/userMapper';
import { runDiscoveryPipeline, DISCOVERY_FETCH_LIMIT } from '@/services/discoveryPipeline';
import { obfuscateCandidatePreview } from '@/services/previewObfuscation';
import { getSearchQuota, useSearchQuota } from '@/services/searchQuotaService';
import { getBoostedUserIds } from '@/services/boostService';
import { getPremiumUserIds } from '@/services/subscriptionService';
import { interleaveByBoost } from '@/services/interleaveResults';
import { validateSearchFilters } from '@/config/validation';
import { logger } from '@/config/logger';

const MAX_RESULTS = 25;

/** Add slight score jitter (±10 pts) so results with similar scores get shuffled */
function addRandomness(candidates: MatchCandidate[]): MatchCandidate[] {
    return candidates
        .map((c) => ({ c, sortKey: (c.score ?? 0) + (Math.random() - 0.5) * 20 }))
        .sort((a, b) => b.sortKey - a.sortKey)
        .map((x) => x.c);
}

registerCommand<WSRequest_SearchWithToken>(
    'search-with-token',
    async (client: Client, payload): Promise<WSResponse_SearchWithToken> => {
        const { filters } = payload;

        try {
            const validationError = validateSearchFilters(filters);
            if (validationError) return { command: 'search-with-token', payload: { error: validationError } };

            const quota = await getSearchQuota(client.userId);
            if (quota.dailyLimit !== -1 && quota.remaining <= 0) {
                return { command: 'search-with-token', payload: { error: 'no_tokens' } };
            }

            // Single source of truth: same pipeline as get-candidates and get-candidate-counts.
            const { qualified, ctx } = await runDiscoveryPipeline(client, filters, DISCOVERY_FETCH_LIMIT);
            const totalCount = qualified.length;

            const candidateIds = qualified.map((s) => s.user.id);
            const [boostedIds, premiumIds] = await Promise.all([getBoostedUserIds(), getPremiumUserIds(candidateIds)]);

            const allCandidates = qualified.map((s) => {
                const shouldPreview = !ctx.myProfileComplete;
                const candidate = mapUserToCandidate(s.user, ctx.prefIntentionKeys, ctx.myLatLng, {
                    photoKeyMode: shouldPreview ? 'blurred' : 'clear',
                    isPremium: premiumIds.has(s.user.id),
                    isBoosted: boostedIds.has(s.user.id)
                });
                candidate.score = s.score;
                candidate.intentionMatch = s.intentionMatch;
                return shouldPreview ? obfuscateCandidatePreview(candidate) : candidate;
            });

            const interleaved = interleaveByBoost(allCandidates, boostedIds);

            // Add slight randomness and limit to MAX_RESULTS
            const shuffled = addRandomness(interleaved).slice(0, MAX_RESULTS);

            // Only consume a token if there are actual results
            let remaining = quota.remaining;
            if (shuffled.length > 0) {
                const nextQuota = await useSearchQuota(client.userId);
                remaining = nextQuota.remaining;
            }

            logger.debug(`[Search] ${shuffled.length}/${totalCount} results (with token) for user: ${client.userId}`);
            return { command: 'search-with-token', payload: { results: shuffled, remaining, totalCount } };
        } catch (error) {
            logger.error('[Search] Search with token error', error);
            return { command: 'search-with-token', payload: { error: 'Internal error' } };
        }
    }
);
