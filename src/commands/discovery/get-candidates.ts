import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetCandidates, WSResponse_GetCandidates } from '@oxyfoo/whymeet-types';
import { mapUserToCandidate } from '@/services/userMapper';
import { getSwipeQuota } from '@/services/swipeQuotaService';
import { getBoostedUserIds } from '@/services/boostService';
import { interleaveByBoost } from '@/services/interleaveResults';
import { runDiscoveryPipeline, DISCOVERY_FETCH_LIMIT } from '@/services/discoveryPipeline';
import { obfuscateCandidatePreview } from '@/services/previewObfuscation';
import { validateSearchFilters } from '@/config/validation';
import { logger } from '@/config/logger';
import { enrichProfileIntentionsFromFilters } from '@/services/intentionProfileEnrichment';

registerCommand<WSRequest_GetCandidates>(
    'get-candidates',
    async (client: Client, payload): Promise<WSResponse_GetCandidates> => {
        const filters = payload.filters;

        try {
            const validationError = validateSearchFilters(filters);
            if (validationError) return { command: 'get-candidates', payload: { error: validationError } };

            const { qualified, ctx } = await runDiscoveryPipeline(client, filters, DISCOVERY_FETCH_LIMIT);
            await enrichProfileIntentionsFromFilters(client.userId, filters);

            const quota = await getSwipeQuota(client.userId);
            const quotaExhausted = quota.dailyLimit !== -1 && quota.remaining <= 0;
            const shouldPreview = !ctx.myProfileComplete || quotaExhausted;

            // Take top 20 and map to client-facing candidates
            const scoredCandidates = qualified.slice(0, 20).map((s) => {
                const candidate = mapUserToCandidate(s.user, ctx.prefIntentionKeys, ctx.myLatLng, {
                    photoKeyMode: shouldPreview ? 'blurred' : 'clear'
                });
                candidate.score = s.score;
                candidate.intentionMatch = s.intentionMatch;
                return shouldPreview ? obfuscateCandidatePreview(candidate) : candidate;
            });

            // Apply 60/40 boost interleave
            const boostedIds = await getBoostedUserIds();
            const candidates = interleaveByBoost(scoredCandidates, boostedIds);

            logger.debug(
                `[Discovery] ${candidates.length} candidates (${qualified.length} total) for user: ${client.userId}`
            );
            return {
                command: 'get-candidates',
                payload: {
                    candidates,
                    totalAvailable: qualified.length,
                    remaining: quota.remaining,
                    dailyLimit: quota.dailyLimit
                }
            };
        } catch (error) {
            logger.error('[Discovery] Get candidates error', error);
            return { command: 'get-candidates', payload: { error: 'Internal error' } };
        }
    }
);
