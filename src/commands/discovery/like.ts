import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_Like, WSResponse_Like } from '@whymeet/types';
import { logger } from '@/config/logger';

registerCommand<WSRequest_Like>('like', async (client: Client, payload): Promise<WSResponse_Like> => {
    const { candidateId } = payload;

    // TODO: Create match record, check for mutual match, create conversation if mutual
    logger.debug(`[Discovery] User ${client.userId} liked ${candidateId}`);

    return { command: 'like', payload: { matched: false } };
});
