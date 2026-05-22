jest.mock('@/config/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), success: jest.fn() }
}));

const mockUserFindUnique = jest.fn();
const mockUserUpdate = jest.fn();

jest.mock('@/services/database', () => ({
    getDatabase: () => ({
        user: {
            findUnique: mockUserFindUnique,
            update: mockUserUpdate
        }
    })
}));

import '@/commands/account/delete-account';
import { routeCommand } from '@/server/Router';
import type { Client } from '@/server/Client';

function fakeClient(userId = 'user-1'): Client {
    return { userId, id: 'client-1', ip: '127.0.0.1', deviceId: 'device-1', close: jest.fn() } as unknown as Client;
}

describe('delete-account command', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('soft-deletes the user without removing evidence-linked rows', async () => {
        mockUserFindUnique.mockResolvedValue({ id: 'user-1', email: 'alice@example.com' });
        mockUserUpdate.mockResolvedValue({ id: 'user-1', deleted: true });
        const client = fakeClient('user-1');

        const result = await routeCommand(client, {
            command: 'delete-account',
            payload: { confirmation: 'alice@example.com' }
        } as never);

        expect(mockUserFindUnique).toHaveBeenCalledWith({ where: { id: 'user-1' } });
        expect(mockUserUpdate).toHaveBeenCalledWith({
            where: { id: 'user-1' },
            data: { deleted: true, deletedAt: expect.any(Date) }
        });
        expect(client.close).toHaveBeenCalledWith(1000, 'Account deleted');
        expect(result).toEqual({ command: 'delete-account', payload: { success: true } });
    });

    it('does not delete or archive when email confirmation mismatches', async () => {
        mockUserFindUnique.mockResolvedValue({ id: 'user-1', email: 'alice@example.com' });

        const result = await routeCommand(fakeClient('user-1'), {
            command: 'delete-account',
            payload: { confirmation: 'wrong@example.com' }
        } as never);

        expect(mockUserUpdate).not.toHaveBeenCalled();
        expect(result).toEqual({ command: 'delete-account', payload: { error: 'Confirmation does not match' } });
    });
});
