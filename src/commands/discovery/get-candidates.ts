import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetCandidates, WSResponse_GetCandidates } from '@whymeet/types';
import { mapUserToCandidate } from '@/services/userMapper';
import { getQuota } from '@/services/swipeQuotaService';
import { getBoostedUserIds } from '@/services/boostService';
import { interleaveByBoost } from '@/services/interleaveResults';
import { runDiscoveryPipeline } from '@/services/discoveryPipeline';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetCandidates>(
    'get-candidates',
    async (client: Client, payload): Promise<WSResponse_GetCandidates> => {
        const filters = payload.filters;

        try {
            const { qualified, ctx } = await runDiscoveryPipeline(client, filters, 5000);

            // Take top 20 and map to client-facing candidates
            const scoredCandidates = qualified.slice(0, 20).map((s) => {
                const candidate = mapUserToCandidate(s.user, ctx.prefIntentions, ctx.myLatLng);
                candidate.score = s.score;
                if (!ctx.myProfileComplete) {
                    candidate.blurred = true;
                }
                return candidate;
            });

            // Apply 60/40 boost interleave
            const boostedIds = await getBoostedUserIds();
            const candidates = interleaveByBoost(scoredCandidates, boostedIds);

            // Get swipe quota info
            const quota = await getQuota(client.userId);

            logger.debug(
                `[Discovery] ${candidates.length} candidates (${qualified.length} total) for user: ${client.userId}`
            );
            return {
                command: 'get-candidates',
                payload: {
                    candidates,
                    totalAvailable: qualified.length,
                    swipesRemaining: quota.swipesRemaining,
                    dailySwipeLimit: quota.dailySwipeLimit
                }
            };
        } catch (error) {
            logger.error('[Discovery] Get candidates error', error);
            return { command: 'get-candidates', payload: { error: 'Internal error' } };
        }
    }
);
