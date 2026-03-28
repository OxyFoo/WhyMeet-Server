import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_Handshake, WSResponse_Handshake } from '@whymeet/types';
import { APP_VERSION } from '@/config/version';

registerCommand<WSRequest_Handshake>('handshake', async (_client: Client, payload): Promise<WSResponse_Handshake> => {
    const { version } = payload;
    return {
        command: 'handshake',
        payload: {
            success: version === APP_VERSION,
            serverVersion: APP_VERSION
        }
    };
});
