import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_Search, WSResponse_Search } from '@whymeet/types';
import { logger } from '@/config/logger';

registerCommand<WSRequest_Search>('search', async (client: Client, _payload): Promise<WSResponse_Search> => {
    if (!client.authenticated || !client.userId) {
        return { command: 'search', payload: { error: 'Not authenticated' } };
    }

    // TODO: Implement search with filters
    logger.debug(`[Search] Search by user: ${client.userId}`);

    return { command: 'search', payload: { results: [] } };
});
