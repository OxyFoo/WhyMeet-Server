// Router is a stateful singleton (module-level Map). We test it via its public API.
// We need to mock the logger to avoid env validation at import time.

jest.mock('@/config/logger', () => ({
    logger: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        success: jest.fn()
    }
}));

import { registerCommand, routeCommand, getRegisteredCommands } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSClientRequest } from '@whymeet/types';

function fakeClient(userId = 'user-1'): Client {
    return { userId, id: 'client-1', ip: '127.0.0.1', deviceId: 'dev-1' } as Client;
}

describe('Router', () => {
    describe('registerCommand + routeCommand', () => {
        it('registers a command and routes it correctly', async () => {
            const handler = jest.fn(async () => ({
                command: 'handshake' as const,
                payload: { success: true, serverVersion: '1.0' }
            }));

            registerCommand<WSClientRequest>('handshake', handler);

            const client = fakeClient();
            const request: WSClientRequest = { command: 'handshake', payload: { version: '1.0' } };
            const result = await routeCommand(client, request);

            expect(handler).toHaveBeenCalledWith(client, request.payload);
            expect(result).toEqual({ command: 'handshake', payload: { success: true, serverVersion: '1.0' } });
        });

        it('returns null for unknown commands', async () => {
            const result = await routeCommand(fakeClient(), { command: 'unknown-cmd' as never, payload: {} });
            expect(result).toBeNull();
        });

        it('returns null when handler throws', async () => {
            registerCommand<WSClientRequest>('get-profile', async () => {
                throw new Error('DB down');
            });

            const result = await routeCommand(fakeClient(), { command: 'get-profile', payload: {} } as WSClientRequest);
            expect(result).toBeNull();
        });
    });

    describe('getRegisteredCommands', () => {
        it('returns all registered command names', () => {
            const commands = getRegisteredCommands();
            expect(commands).toContain('handshake');
            expect(commands).toContain('get-profile');
        });
    });
});
