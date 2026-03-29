jest.mock('@/config/logger', () => ({
    logger: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        success: jest.fn()
    }
}));

import { WebSocket } from 'ws';
import { Client } from '@/server/Client';

// Minimal WebSocket mock
function mockWs(readyState: number = WebSocket.OPEN) {
    return {
        readyState,
        send: jest.fn(),
        close: jest.fn()
    } as unknown as WebSocket;
}

describe('Client', () => {
    describe('constructor', () => {
        it('stores id, ws, ip, userId, deviceId', () => {
            const ws = mockWs();
            const client = new Client('c1', ws, '10.0.0.1', 'u1', 'd1');

            expect(client.id).toBe('c1');
            expect(client.ws).toBe(ws);
            expect(client.ip).toBe('10.0.0.1');
            expect(client.userId).toBe('u1');
            expect(client.deviceId).toBe('d1');
        });
    });

    describe('send', () => {
        it('sends JSON envelope when connection is OPEN', () => {
            const ws = mockWs();
            const client = new Client('c1', ws, '127.0.0.1', 'u1', 'd1');

            client.send({ command: 'handshake', payload: { version: '1' } } as never, 'req-123');

            expect(ws.send).toHaveBeenCalledTimes(1);
            const raw = (ws.send as jest.Mock).mock.calls[0][0] as string;
            const envelope = JSON.parse(raw);

            expect(envelope.id).toBe('req-123');
            expect(envelope.timestamp).toEqual(expect.any(Number));
            expect(envelope.data).toEqual({ command: 'handshake', payload: { version: '1' } });
        });

        it('generates an id when requestId is not provided', () => {
            const ws = mockWs();
            const client = new Client('c1', ws, '127.0.0.1', 'u1', 'd1');

            client.send({ event: 'new-match', payload: {} } as never);

            const raw = (ws.send as jest.Mock).mock.calls[0][0] as string;
            const envelope = JSON.parse(raw);
            expect(envelope.id).toBeTruthy();
        });

        it('does not send when connection is not OPEN', () => {
            const ws = mockWs(WebSocket.CLOSED as number);
            const client = new Client('c1', ws, '127.0.0.1', 'u1', 'd1');

            client.send({ command: 'handshake', payload: {} } as never);

            expect(ws.send).not.toHaveBeenCalled();
        });
    });

    describe('close', () => {
        it('delegates to ws.close', () => {
            const ws = mockWs();
            const client = new Client('c1', ws, '127.0.0.1', 'u1', 'd1');

            client.close(1000, 'bye');

            expect(ws.close).toHaveBeenCalledWith(1000, 'bye');
        });

        it('does not throw when ws.close fails', () => {
            const ws = mockWs();
            (ws.close as jest.Mock).mockImplementation(() => {
                throw new Error('fail');
            });
            const client = new Client('c1', ws, '127.0.0.1', 'u1', 'd1');

            expect(() => client.close()).not.toThrow();
        });
    });

    describe('parseMessage', () => {
        it('parses a valid JSON envelope', () => {
            const ws = mockWs();
            const client = new Client('c1', ws, '127.0.0.1', 'u1', 'd1');

            const raw = JSON.stringify({
                id: 'msg-1',
                timestamp: Date.now(),
                data: { command: 'search', payload: { filters: {} } }
            });

            const result = client.parseMessage(raw);
            expect(result).not.toBeNull();
            expect(result!.id).toBe('msg-1');
            expect(result!.data.command).toBe('search');
        });

        it('returns null for invalid JSON', () => {
            const ws = mockWs();
            const client = new Client('c1', ws, '127.0.0.1', 'u1', 'd1');

            expect(client.parseMessage('not json')).toBeNull();
        });

        it('returns null when id is missing', () => {
            const ws = mockWs();
            const client = new Client('c1', ws, '127.0.0.1', 'u1', 'd1');

            const raw = JSON.stringify({ data: { command: 'search', payload: {} } });
            expect(client.parseMessage(raw)).toBeNull();
        });

        it('returns null when command is missing', () => {
            const ws = mockWs();
            const client = new Client('c1', ws, '127.0.0.1', 'u1', 'd1');

            const raw = JSON.stringify({ id: '1', data: { payload: {} } });
            expect(client.parseMessage(raw)).toBeNull();
        });
    });
});
