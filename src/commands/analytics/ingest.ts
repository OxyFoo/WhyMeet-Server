import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_AnalyticsIngest, WSResponse_AnalyticsIngest } from '@oxyfoo/whymeet-types';

import { recordEvents } from '@/services/analyticsService';

registerCommand<WSRequest_AnalyticsIngest>(
    'analytics-ingest',
    async (client: Client, payload): Promise<WSResponse_AnalyticsIngest> => {
        const { accepted, rejected } = await recordEvents(client.deviceId, payload.events ?? []);
        return {
            command: 'analytics-ingest',
            payload: { accepted, rejected }
        };
    }
);
