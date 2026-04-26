import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_SetDiscoveryView, WSResponse_SetDiscoveryView } from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { logAudit } from '@/services/auditLogService';
import { logger } from '@/config/logger';

const ALLOWED_VIEWS = ['swipe', 'advanced'] as const;

registerCommand<WSRequest_SetDiscoveryView>(
    'set-discovery-view',
    async (client: Client, payload): Promise<WSResponse_SetDiscoveryView> => {
        const view = payload?.view;
        if (!ALLOWED_VIEWS.includes(view as (typeof ALLOWED_VIEWS)[number])) {
            return { command: 'set-discovery-view', payload: { error: 'Invalid view' } };
        }

        try {
            await getDatabase().profile.update({
                where: { userId: client.userId },
                data: { preferredDiscoveryView: view }
            });

            logAudit(client.userId, 'discovery_view_changed', { view });

            return { command: 'set-discovery-view', payload: { ok: true } };
        } catch (error) {
            logger.error('[Profile] Set discovery view error', error);
            return { command: 'set-discovery-view', payload: { error: 'Internal error' } };
        }
    }
);
