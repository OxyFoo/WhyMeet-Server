import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetBoostStatus, WSResponse_GetBoostStatus } from '@oxyfoo/whymeet-types';
import { getBoostStatus } from '@/services/boostService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetBoostStatus>(
    'get-boost-status',
    async (client: Client): Promise<WSResponse_GetBoostStatus> => {
        try {
            const boost = await getBoostStatus(client.userId);
            return { command: 'get-boost-status', payload: { boost } };
        } catch (error) {
            logger.error('[Boost] Get status error', error);
            return { command: 'get-boost-status', payload: { error: 'Internal error' } };
        }
    }
);
