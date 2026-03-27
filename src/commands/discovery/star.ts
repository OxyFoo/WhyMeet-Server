import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_Star, WSResponse_Star } from '@whymeet/types';
import { logger } from '@/config/logger';

registerCommand<WSRequest_Star>('star', async (client: Client, payload): Promise<WSResponse_Star> => {
    const { candidateId } = payload;

    // TODO: Star/super-like logic
    logger.debug(`[Discovery] User ${client.userId} starred ${candidateId}`);

    return { command: 'star', payload: { success: true } };
});
