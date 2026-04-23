import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetCandidateCounts, WSResponse_GetCandidateCounts } from '@oxyfoo/whymeet-types';
import { INTENTION_KEYS } from '@oxyfoo/whymeet-types';
import { buildPipelineContext, runPipelineQuery, DISCOVERY_FETCH_LIMIT } from '@/services/discoveryPipeline';
import { getDiscoveryCounts, setDiscoveryCounts } from '@/services/discoveryCountsCache';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetCandidateCounts>(
    'get-candidate-counts',
    async (client: Client): Promise<WSResponse_GetCandidateCounts> => {
        try {
            // Cache-first: avoid running 7 full pipelines when nothing changed.
            // Invalidated on preference change and every swipe action.
            const cached = await getDiscoveryCounts(client.userId);
            if (cached) {
                logger.debug(`[Discovery] Counts cache hit for ${client.userId}`);
                return { command: 'get-candidate-counts', payload: { counts: cached } };
            }

            // Build context once (user, settings, exclusion list)
            const setup = await buildPipelineContext(client);

            // Run the FULL pipeline (same as swipe/search) per intention in parallel.
            // qualified.length is the single source of truth — includes distance + score
            // filters so the number matches what the user will actually see.
            const entries = await Promise.all(
                INTENTION_KEYS.map(async (key) => {
                    const { qualified } = await runPipelineQuery(setup, { intentions: [key] }, DISCOVERY_FETCH_LIMIT);
                    return [key, qualified.length] as const;
                })
            );
            const counts: Record<string, number> = Object.fromEntries(entries);

            await setDiscoveryCounts(client.userId, counts);

            logger.debug(`[Discovery] Counts for ${client.userId}: ${JSON.stringify(counts)}`);
            return { command: 'get-candidate-counts', payload: { counts } };
        } catch (error) {
            logger.error('[Discovery] Get candidate counts error', error);
            return { command: 'get-candidate-counts', payload: { error: 'Internal error' } };
        }
    }
);
