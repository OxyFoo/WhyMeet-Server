import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_Skip, WSResponse_Skip } from '@whymeet/types';
import { logger } from '@/config/logger';

registerCommand<WSRequest_Skip>('skip', async (client: Client, payload): Promise<WSResponse_Skip> => {
    if (!client.authenticated || !client.userId) {
        return { command: 'skip', payload: { success: false } };
    }

    const { candidateId } = payload;

    // TODO: Record skip
    logger.debug(`[Discovery] User ${client.userId} skipped ${candidateId}`);

    return { command: 'skip', payload: { success: true } };
});
