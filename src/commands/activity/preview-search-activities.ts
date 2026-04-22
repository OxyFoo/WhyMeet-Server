import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type {
    WSRequest_PreviewSearchActivities,
    WSResponse_PreviewSearchActivities,
    ActivitySummary
} from '@oxyfoo/whymeet-types';
import { searchActivities } from '@/services/activityDiscoveryService';
import { obfuscateString } from '@/services/previewObfuscation';
import { logger } from '@/config/logger';

function obfuscateActivity(a: ActivitySummary): ActivitySummary {
    return {
        ...a,
        title: obfuscateString(a.title),
        locationName: obfuscateString(a.locationName),
        hostName: obfuscateString(a.hostName)
    };
}

registerCommand<WSRequest_PreviewSearchActivities>(
    'preview-search-activities',
    async (client: Client, payload): Promise<WSResponse_PreviewSearchActivities> => {
        try {
            const result = await searchActivities(client.userId, payload.filters);
            return {
                command: 'preview-search-activities',
                payload: {
                    activities: result.activities.map(obfuscateActivity),
                    totalCount: result.totalCount
                }
            };
        } catch (error) {
            logger.error('[Activity] Preview search error', error);
            return { command: 'preview-search-activities', payload: { error: 'Internal error' } };
        }
    }
);
