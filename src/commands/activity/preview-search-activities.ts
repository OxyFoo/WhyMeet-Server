import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_PreviewSearchActivities, WSResponse_PreviewSearchActivities } from '@oxyfoo/whymeet-types';
import { searchActivities } from '@/services/activityDiscoveryService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_PreviewSearchActivities>(
    'preview-search-activities',
    async (client: Client, payload): Promise<WSResponse_PreviewSearchActivities> => {
        try {
            const result = await searchActivities(client.userId, payload.filters, {
                obfuscationMode: 'force'
            });
            return {
                command: 'preview-search-activities',
                payload: {
                    activities: result.activities,
                    totalCount: result.totalCount
                }
            };
        } catch (error) {
            logger.error('[Activity] Preview search error', error);
            return { command: 'preview-search-activities', payload: { error: 'Internal error' } };
        }
    }
);
