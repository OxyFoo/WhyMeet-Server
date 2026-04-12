import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_RegisterPushToken, WSResponse_RegisterPushToken } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_RegisterPushToken>(
    'register-push-token',
    async (client: Client, payload): Promise<WSResponse_RegisterPushToken> => {
        const { token, provider } = payload;
        const db = getDatabase();

        try {
            await db.device.update({
                where: { id: client.deviceId },
                data: { pushToken: token, pushProvider: provider }
            });

            logger.debug(`[Push] Registered ${provider} token for device ${client.deviceId} (user ${client.userId})`);

            return { command: 'register-push-token', payload: { success: true } };
        } catch (error) {
            logger.error('[Push] Register token error', error);
            return { command: 'register-push-token', payload: { error: 'Internal error' } };
        }
    }
);
