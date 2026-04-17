import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetCandidateCounts, WSResponse_GetCandidateCounts } from '@oxyfoo/whymeet-types';
import { INTENTION_KEYS } from '@oxyfoo/whymeet-types';
import { buildPipelineContext, runPipelineQuery } from '@/services/discoveryPipeline';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetCandidateCounts>(
    'get-candidate-counts',
    async (client: Client): Promise<WSResponse_GetCandidateCounts> => {
        try {
            // Build context once (user, settings, exclusion list)
            const setup = await buildPipelineContext(client);

            // Run the SAME pipeline per intention but with a higher limit
            // so counts reflect reality, not a fetch cap.
            const counts: Record<string, number> = {};
            for (const key of INTENTION_KEYS) {
                const { qualified } = await runPipelineQuery(setup, { intentions: [key] }, 5000);
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
