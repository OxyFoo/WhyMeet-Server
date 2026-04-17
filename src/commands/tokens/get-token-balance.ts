import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetTokenBalance, WSResponse_GetTokenBalance } from '@oxyfoo/whymeet-types';
import { getBalance } from '@/services/tokenService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetTokenBalance>(
    'get-token-balance',
    async (client: Client): Promise<WSResponse_GetTokenBalance> => {
        try {
            const balance = await getBalance(client.userId);
            return { command: 'get-token-balance', payload: { balance } };
        } catch (error) {
            logger.error('[Tokens] Get balance error', error);
            return { command: 'get-token-balance', payload: { error: 'Internal error' } };
        }
    }
);
