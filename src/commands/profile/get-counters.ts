/**
 * @file get-counters.ts
 * @description Returns lightweight aggregated counters used by the mobile
 * UI to power badges (inbox unread, pending match requests, unread
 * notifications). The pending request count intentionally mirrors the
 * visibility filter used by `get-requests` so list and badge stay aligned.
 */

import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetCounters, WSResponse_GetCounters } from '@oxyfoo/whymeet-types';
import { getUserCounters } from '@/services/userCounters';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetCounters>('get-counters', async (client: Client): Promise<WSResponse_GetCounters> => {
    try {
        return {
            command: 'get-counters',
            payload: {
                counters: await getUserCounters(client.userId)
            }
        };
    } catch (error) {
        logger.error('[Counters] Get counters error', error);
        return { command: 'get-counters', payload: { error: 'Internal error' } };
    }
});
