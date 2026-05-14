import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_SearchWithToken, WSResponse_SearchWithToken, MatchCandidate } from '@oxyfoo/whymeet-types';
import { mapUserToCandidate } from '@/services/userMapper';
import { runDiscoveryPipeline, DISCOVERY_FETCH_LIMIT } from '@/services/discoveryPipeline';
import { obfuscateString } from '@/services/previewObfuscation';
import { getSearchQuota, useSearchQuota } from '@/services/searchQuotaService';
import { getBoostedUserIds } from '@/services/boostService';
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

            const allCandidates = qualified.map((s) => {
                const candidate = mapUserToCandidate(s.user, ctx.prefIntentionKeys, ctx.myLatLng);
                candidate.score = s.score;
                candidate.intentionMatch = s.intentionMatch;
                if (!ctx.myProfileComplete) {
                    candidate.blurred = true;
                    candidate.bio = obfuscateString(candidate.bio);
                    candidate.interests = candidate.interests.map(obfuscateString);
                    candidate.skills = candidate.skills.map(obfuscateString);
                }
                return candidate;
            });

            // Apply 60/40 boost interleave
            const boostedIds = await getBoostedUserIds();
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
