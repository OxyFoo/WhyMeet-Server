import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetSearchQuota, WSResponse_GetSearchQuota } from '@oxyfoo/whymeet-types';
import { getSearchQuota } from '@/services/searchQuotaService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetSearchQuota>(
    'get-search-quota',
    async (client: Client): Promise<WSResponse_GetSearchQuota> => {
        try {
            const quota = await getSearchQuota(client.userId);
            return { command: 'get-search-quota', payload: { quota } };
        } catch (error) {
            logger.error('[Search] Get quota error', error);
            return { command: 'get-search-quota', payload: { error: 'Internal error' } };
        }
    }
);
