import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetSubIntentionCounts, WSResponse_GetSubIntentionCounts } from '@oxyfoo/whymeet-types';
import { SUB_INTENTIONS } from '@oxyfoo/whymeet-types';
import { buildPipelineContext, runPipelineQuery } from '@/services/discoveryPipeline';
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

            const setup = await buildPipelineContext(client);

            const counts: Record<string, number> = {};
            for (const sub of subs) {
                const { qualified } = await runPipelineQuery(setup, { intentions: [intention], tags: sub.tags }, 300);
                counts[sub.key] = qualified.length;
            }

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
