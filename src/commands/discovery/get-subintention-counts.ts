import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetSubIntentionCounts, WSResponse_GetSubIntentionCounts } from '@oxyfoo/whymeet-types';
import { SUB_INTENTIONS } from '@oxyfoo/whymeet-types';
import {
    buildPipelineContext,
    countQualifiedBySubIntention,
    runPipelineQuery,
    DISCOVERY_FETCH_LIMIT
} from '@/services/discoveryPipeline';
import { getOrComputeSubIntentionCounts } from '@/services/discoveryCountsCache';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetSubIntentionCounts>(
    'get-subintention-counts',
    async (client: Client, payload): Promise<WSResponse_GetSubIntentionCounts> => {
        try {
            const { intention } = payload;
            const subs = SUB_INTENTIONS[intention] ?? [];

            if (subs.length === 0) {
                return { command: 'get-subintention-counts', payload: { counts: {} } };
            }

            const counts = await getOrComputeSubIntentionCounts(client.userId, intention, async () => {
                const setup = await buildPipelineContext(client);
                const scopeTags = [...new Set(subs.flatMap((sub) => sub.tags))];
                if (scopeTags.length === 0) return Object.fromEntries(subs.map((sub) => [sub.key, 0]));

                const { qualified } = await runPipelineQuery(
                    setup,
                    { intentions: [intention], tags: scopeTags },
                    DISCOVERY_FETCH_LIMIT
                );
                return countQualifiedBySubIntention(qualified, subs);
            });

            logger.debug(
                `[Discovery] Sub-intention counts for ${client.userId} / ${intention}: ${JSON.stringify(counts)}`
            );
            return { command: 'get-subintention-counts', payload: { counts } };
        } catch (error) {
            logger.error('[Discovery] Get sub-intention counts error', error);
            return { command: 'get-subintention-counts', payload: { error: 'Internal error' } };
        }
    }
);
