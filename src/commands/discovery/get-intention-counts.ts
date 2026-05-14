import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetIntentionCounts, WSResponse_GetIntentionCounts } from '@oxyfoo/whymeet-types';
import { getIntentionsForCategory } from '@oxyfoo/whymeet-types';
import {
    buildPipelineContext,
    countQualifiedByIntention,
    DISCOVERY_FETCH_LIMIT,
    runPipelineQuery
} from '@/services/discoveryPipeline';
import { getOrComputeIntentionCounts } from '@/services/discoveryCountsCache';
import { validateSearchFilters } from '@/config/validation';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetIntentionCounts>(
    'get-intention-counts',
    async (client: Client, payload): Promise<WSResponse_GetIntentionCounts> => {
        try {
            const { categoryKey } = payload;
            const validationError = validateSearchFilters({ categoryKey: categoryKey });
            if (validationError) return { command: 'get-intention-counts', payload: { error: validationError } };

            const intentions = getIntentionsForCategory(categoryKey);
            const intentionKeys = intentions.map((intention) => intention.key);

            if (intentionKeys.length === 0) {
                return { command: 'get-intention-counts', payload: { counts: {} } };
            }

            const counts = await getOrComputeIntentionCounts(client.userId, categoryKey, async () => {
                const setup = await buildPipelineContext(client);
                const { qualified } = await runPipelineQuery(
                    setup,
                    { categoryKey: categoryKey, intentionKeys: intentionKeys },
                    DISCOVERY_FETCH_LIMIT
                );
                return countQualifiedByIntention(qualified, intentionKeys);
            });

            logger.debug(
                `[Discovery] Intention counts for ${client.userId} / ${categoryKey}: ${JSON.stringify(counts)}`
            );
            return { command: 'get-intention-counts', payload: { counts } };
        } catch (error) {
            logger.error('[Discovery] Get intention counts error', error);
            return { command: 'get-intention-counts', payload: { error: 'Internal error' } };
        }
    }
);
