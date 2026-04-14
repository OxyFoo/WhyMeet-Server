import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetCandidateCounts, WSResponse_GetCandidateCounts } from '@whymeet/types';
import { INTENTION_KEYS } from '@whymeet/types';
import { buildPipelineContext, runPipelineQuery } from '@/services/discoveryPipeline';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetCandidateCounts>(
    'get-candidate-counts',
    async (client: Client): Promise<WSResponse_GetCandidateCounts> => {
        try {
            // Build context once (user, settings, exclusion list)
            const setup = await buildPipelineContext(client);

            // Run the SAME pipeline per intention, with the SAME fetchLimit (100)
            // as get-candidates, so counts are perfectly consistent.
            const counts: Record<string, number> = {};
            for (const key of INTENTION_KEYS) {
                const { qualified } = await runPipelineQuery(setup, { intentions: [key] }, 100);
                counts[key] = qualified.length;
            }

            logger.debug(`[Discovery] Counts for ${client.userId}: ${JSON.stringify(counts)}`);
            return { command: 'get-candidate-counts', payload: { counts } };
        } catch (error) {
            logger.error('[Discovery] Get candidate counts error', error);
            return { command: 'get-candidate-counts', payload: { error: 'Internal error' } };
        }
    }
);
