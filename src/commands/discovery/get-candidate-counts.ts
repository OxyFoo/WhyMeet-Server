import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetCandidateCounts, WSResponse_GetCandidateCounts } from '@oxyfoo/whymeet-types';
import { INTENTION_KEYS, INTENTION_CATEGORY_KEYS } from '@oxyfoo/whymeet-types';
import {
    buildPipelineContext,
    countQualifiedByIntentionCategory,
    runPipelineQuery,
    DISCOVERY_FETCH_LIMIT
} from '@/services/discoveryPipeline';
import { getOrComputeDiscoveryCounts } from '@/services/discoveryCountsCache';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetCandidateCounts>(
    'get-candidate-counts',
    async (client: Client): Promise<WSResponse_GetCandidateCounts> => {
        try {
            const counts = await getOrComputeDiscoveryCounts(client.userId, async () => {
                const setup = await buildPipelineContext(client);
                const { qualified } = await runPipelineQuery(
                    setup,
                    { intentionKeys: [...INTENTION_KEYS] },
                    DISCOVERY_FETCH_LIMIT
                );
                return countQualifiedByIntentionCategory(qualified, INTENTION_CATEGORY_KEYS);
            });

            return { command: 'get-candidate-counts', payload: { counts } };
        } catch (error) {
            logger.error('[Discovery] Get candidate counts error', error);
            return { command: 'get-candidate-counts', payload: { error: 'Internal error' } };
        }
    }
);
