import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetCandidates, WSResponse_GetCandidates } from '@whymeet/types';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetCandidates>(
    'get-candidates',
    async (client: Client, _payload): Promise<WSResponse_GetCandidates> => {
        if (!client.authenticated || !client.userId) {
            return { command: 'get-candidates', payload: { error: 'Not authenticated' } };
        }

        // TODO: Implement candidate discovery logic with filters
        logger.debug(`[Discovery] Get candidates for user: ${client.userId}`);

        return { command: 'get-candidates', payload: { candidates: [] } };
    }
);
