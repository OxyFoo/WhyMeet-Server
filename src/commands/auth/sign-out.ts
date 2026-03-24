import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_SignOut, WSResponse_SignOut } from '@whymeet/types';
import { logger } from '@/config/logger';

registerCommand<WSRequest_SignOut>('sign-out', async (client: Client): Promise<WSResponse_SignOut> => {
    logger.info(`[Auth] User signed out: ${client.userId}`);
    client.userId = null;
    client.authenticated = false;
    return { command: 'sign-out', payload: { success: true } };
});
