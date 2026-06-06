import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetPolls, WSResponse_GetPolls } from '@oxyfoo/whymeet-types';
import { getActivePolls } from '@/services/pollService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetPolls>('get-polls', async (client: Client): Promise<WSResponse_GetPolls> => {
    try {
        const polls = await getActivePolls(client.userId);
        return { command: 'get-polls', payload: { polls } };
    } catch (err) {
        logger.error(`[Polls] get-polls failed for user ${client.userId}: ${(err as Error).message}`);
        return { command: 'get-polls', payload: { error: 'Failed to load polls' } };
    }
});
