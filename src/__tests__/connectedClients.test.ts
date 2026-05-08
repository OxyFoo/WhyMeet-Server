import type { Client } from '@/server/Client';
import {
    clearConnectedClients,
    getClientsForUser,
    getConnectedClients,
    isUserConnected,
    registerConnectedClient,
    sendToUser,
    unregisterConnectedClient
} from '@/server/connectedClients';

function fakeClient(id: string, userId: string): Client {
    return {
        id,
        userId,
        send: jest.fn(),
        close: jest.fn()
    } as unknown as Client;
}

describe('connectedClients registry', () => {
    beforeEach(() => {
        clearConnectedClients();
    });

    afterEach(() => {
        clearConnectedClients();
    });

    it('indexes multiple connections for the same user', () => {
        const a = fakeClient('a', 'user-1');
        const b = fakeClient('b', 'user-1');
        const c = fakeClient('c', 'user-2');

        registerConnectedClient(a);
        registerConnectedClient(b);
        registerConnectedClient(c);

        expect(getConnectedClients().size).toBe(3);
        expect(getClientsForUser('user-1')).toEqual(expect.arrayContaining([a, b]));
        expect(getClientsForUser('user-2')).toEqual([c]);
        expect(isUserConnected('user-1')).toBe(true);
    });

    it('unregisters by id without removing other devices', () => {
        const a = fakeClient('a', 'user-1');
        const b = fakeClient('b', 'user-1');

        registerConnectedClient(a);
        registerConnectedClient(b);
        unregisterConnectedClient('a');

        expect(getConnectedClients().has('a')).toBe(false);
        expect(getClientsForUser('user-1')).toEqual([b]);
        expect(isUserConnected('user-1')).toBe(true);
    });

    it('sends to every connected device for a user', () => {
        const a = fakeClient('a', 'user-1');
        const b = fakeClient('b', 'user-1');
        const other = fakeClient('c', 'user-2');

        registerConnectedClient(a);
        registerConnectedClient(b);
        registerConnectedClient(other);

        const count = sendToUser('user-1', { event: 'notification', payload: { notification: {} } } as never);

        expect(count).toBe(2);
        expect(a.send).toHaveBeenCalledTimes(1);
        expect(b.send).toHaveBeenCalledTimes(1);
        expect(other.send).not.toHaveBeenCalled();
    });
});
