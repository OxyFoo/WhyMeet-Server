import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_Handshake, WSResponse_Handshake } from '@whymeet/types';

import { readFileSync } from 'fs';
import { resolve } from 'path';

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
const SERVER_VERSION: string = pkg.version;

registerCommand<WSRequest_Handshake>('handshake', async (_client: Client, payload): Promise<WSResponse_Handshake> => {
    const { version } = payload;
    return {
        command: 'handshake',
        payload: {
            success: version === SERVER_VERSION,
            serverVersion: SERVER_VERSION
        }
    };
});
