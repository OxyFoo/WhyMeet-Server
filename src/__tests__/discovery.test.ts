// ─── Mocks ──────────────────────────────────────────────────────────

jest.mock('@/config/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), success: jest.fn() }
}));

const mockUserFindUnique = jest.fn();
const mockUserFindMany = jest.fn();
const mockMatchFindMany = jest.fn();
const mockMatchUpsert = jest.fn();
const mockMatchFindFirst = jest.fn();
const mockMatchUpdateMany = jest.fn();
const mockConversationCreate = jest.fn();
const mockBlockFindMany = jest.fn();
const mockProfileUpdateMany = jest.fn();
const mockNotificationCreate = jest.fn();
const mockSettingsFindUnique = jest.fn();

jest.mock('@/services/database', () => ({
    getDatabase: () => ({
        user: { findUnique: mockUserFindUnique, findMany: mockUserFindMany },
        match: {
            findMany: mockMatchFindMany,
            upsert: mockMatchUpsert,
            findFirst: mockMatchFindFirst,
            updateMany: mockMatchUpdateMany
        },
        conversation: { create: mockConversationCreate },
        block: { findMany: mockBlockFindMany },
        profile: { updateMany: mockProfileUpdateMany },
        notification: { create: mockNotificationCreate },
        settings: { findUnique: mockSettingsFindUnique }
    })
}));

const mockConnectedClients = new Map();
jest.mock('@/server/Server', () => ({
    getConnectedClients: () => mockConnectedClients
}));

// Import commands to trigger registerCommand
import '@/commands/discovery/get-candidates';
import '@/commands/discovery/like';
import '@/commands/discovery/skip';
import '@/commands/discovery/star';
import { routeCommand } from '@/server/Router';
import type { Client } from '@/server/Client';

function fakeClient(userId = 'me'): Client {
    return { userId, id: 'c1', ip: '127.0.0.1', deviceId: 'd1' } as Client;
}

function prismaUser(id: string, intentions: string[] = ['dating'], tagLabels: string[] = ['Hiking']) {
    return {
        id,
        name: 'User',
        age: 25,
        avatar: '',
        city: 'Paris',
        verified: true,
        profile: {
            bio: 'bio',
            socialVibe: 'chill',
            country: 'FR',
            region: 'IDF',
            city: 'Paris',
            latitude: null,
            longitude: null,
            statConnections: 0,
            statMatches: 0,
            statVibes: 0,
            intentions
        },
        tags: tagLabels.map((label, i) => ({ type: 'interest', tag: { id: `t${i}`, label } }))
    };
}

// ─── get-candidates ─────────────────────────────────────────────────

describe('get-candidates command', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockBlockFindMany.mockResolvedValue([]);
        mockSettingsFindUnique.mockResolvedValue(null);
    });

    it('excludes current user and already-seen users', async () => {
        mockUserFindUnique.mockResolvedValue(prismaUser('me', ['dating'], ['Yoga']));
        mockMatchFindMany.mockResolvedValue([{ receiverId: 'seen-1' }, { receiverId: 'seen-2' }]);
        mockUserFindMany.mockResolvedValue([]);

        await routeCommand(fakeClient('me'), {
            command: 'get-candidates',
            payload: { filters: {} }
        } as never);

        const where = mockUserFindMany.mock.calls[0][0].where;
        expect(where.id.notIn).toContain('me');
        expect(where.id.notIn).toContain('seen-1');
        expect(where.id.notIn).toContain('seen-2');
    });

    it('scores candidates by common intentions (+2) and tags (+1)', async () => {
        mockUserFindUnique.mockResolvedValue(prismaUser('me', ['dating', 'friendship'], ['Yoga', 'Café']));
        mockMatchFindMany.mockResolvedValue([]);
        // candidate-A: 1 common intention (dating) + 1 common tag (Yoga) => score 3
        // candidate-B: 2 common intentions (dating, friendship) + 0 common tags => score 4
        mockUserFindMany.mockResolvedValue([
            prismaUser('A', ['dating'], ['Yoga']),
            prismaUser('B', ['dating', 'friendship'], ['Surf'])
        ]);

        const result = await routeCommand(fakeClient('me'), {
            command: 'get-candidates',
            payload: {}
        } as never);

        const candidates = (result as { payload: { candidates: { id: string }[] } }).payload.candidates;
        expect(candidates).toHaveLength(2);
        // B has higher score (4) than A (3), should be first
        expect(candidates[0].id).toBe('B');
        expect(candidates[1].id).toBe('A');
    });

    it('limits output to 20 candidates', async () => {
        mockUserFindUnique.mockResolvedValue(prismaUser('me'));
        mockMatchFindMany.mockResolvedValue([]);
        const manyUsers = Array.from({ length: 30 }, (_, i) => prismaUser(`u${i}`));
        mockUserFindMany.mockResolvedValue(manyUsers);

        const result = await routeCommand(fakeClient('me'), {
            command: 'get-candidates',
            payload: {}
        } as never);

        const candidates = (result as { payload: { candidates: unknown[] } }).payload.candidates;
        expect(candidates).toHaveLength(20);
    });

    it('returns error payload on DB failure', async () => {
        mockUserFindUnique.mockRejectedValue(new Error('fail'));

        const result = await routeCommand(fakeClient(), {
            command: 'get-candidates',
            payload: {}
        } as never);

        expect(result).toEqual(
            expect.objectContaining({ payload: expect.objectContaining({ error: 'Internal error' }) })
        );
    });
});

// ─── like ───────────────────────────────────────────────────────────

describe('like command', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockProfileUpdateMany.mockResolvedValue({});
        mockNotificationCreate.mockResolvedValue({ id: 'n1', title: 'test', body: 'test', createdAt: new Date() });
        mockUserFindUnique.mockResolvedValue(prismaUser('me'));
    });

    it('creates a match record and returns matched:false when no reverse', async () => {
        mockMatchUpsert.mockResolvedValue({ id: 'm1' });
        mockMatchFindFirst.mockResolvedValue(null);

        const result = await routeCommand(fakeClient('me'), {
            command: 'like',
            payload: { candidateId: 'other' }
        } as never);

        expect(mockMatchUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { senderId_receiverId_category: { senderId: 'me', receiverId: 'other', category: 'like' } }
            })
        );
        expect((result as { payload: { matched: boolean } }).payload.matched).toBe(false);
    });

    it('returns matched:true and creates conversation on mutual match', async () => {
        mockMatchUpsert.mockResolvedValue({ id: 'm1' });
        mockMatchFindFirst.mockResolvedValue({ id: 'm2' }); // reverse exists
        mockMatchUpdateMany.mockResolvedValue({});
        mockConversationCreate.mockResolvedValue({ id: 'conv-1' });
        mockUserFindUnique.mockResolvedValue(prismaUser('me'));

        const result = await routeCommand(fakeClient('me'), {
            command: 'like',
            payload: { candidateId: 'other' }
        } as never);

        expect(mockMatchUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { mutual: true } }));
        expect(mockConversationCreate).toHaveBeenCalled();
        expect((result as { payload: { matched: boolean } }).payload.matched).toBe(true);
    });

    it('pushes new-match event to connected candidate', async () => {
        mockMatchUpsert.mockResolvedValue({ id: 'm1' });
        mockMatchFindFirst.mockResolvedValue({ id: 'm2' });
        mockMatchUpdateMany.mockResolvedValue({});
        mockConversationCreate.mockResolvedValue({ id: 'conv-1' });
        mockUserFindUnique.mockResolvedValue(prismaUser('me'));

        const sendFn = jest.fn();
        mockConnectedClients.set('other-client', { userId: 'other', send: sendFn });

        await routeCommand(fakeClient('me'), {
            command: 'like',
            payload: { candidateId: 'other' }
        } as never);

        expect(sendFn).toHaveBeenCalledWith(expect.objectContaining({ event: 'new-match' }));

        mockConnectedClients.clear();
    });

    it('returns error payload on failure', async () => {
        mockMatchUpsert.mockRejectedValue(new Error('fail'));

        const result = await routeCommand(fakeClient(), {
            command: 'like',
            payload: { candidateId: 'other' }
        } as never);

        expect(result).toEqual(
            expect.objectContaining({ payload: expect.objectContaining({ error: 'Internal error' }) })
        );
    });
});

// ─── skip ───────────────────────────────────────────────────────────

describe('skip command', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('creates a skip match record', async () => {
        mockMatchUpsert.mockResolvedValue({ id: 'm1' });

        const result = await routeCommand(fakeClient('me'), {
            command: 'skip',
            payload: { candidateId: 'other' }
        } as never);

        expect(mockMatchUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({ category: 'skip' })
            })
        );
        expect((result as { payload: { success: boolean } }).payload.success).toBe(true);
    });

    it('returns success:false on failure', async () => {
        mockMatchUpsert.mockRejectedValue(new Error('fail'));

        const result = await routeCommand(fakeClient(), {
            command: 'skip',
            payload: { candidateId: 'other' }
        } as never);

        expect((result as { payload: { success: boolean } }).payload.success).toBe(false);
    });
});

// ─── star ───────────────────────────────────────────────────────────

describe('star command', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockProfileUpdateMany.mockResolvedValue({});
        mockUserFindUnique.mockResolvedValue(prismaUser('me'));
    });

    it('creates a like match with matchContext=star', async () => {
        mockMatchUpsert.mockResolvedValue({ id: 'm1' });
        mockMatchFindFirst.mockResolvedValue(null);

        await routeCommand(fakeClient('me'), {
            command: 'star',
            payload: { candidateId: 'other' }
        } as never);

        expect(mockMatchUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({ category: 'like', matchContext: 'star' }),
                update: { matchContext: 'star' }
            })
        );
    });

    it('detects mutual match just like like command', async () => {
        mockMatchUpsert.mockResolvedValue({ id: 'm1' });
        mockMatchFindFirst.mockResolvedValue({ id: 'm2' });
        mockMatchUpdateMany.mockResolvedValue({});
        mockConversationCreate.mockResolvedValue({ id: 'conv-1' });
        mockUserFindUnique.mockResolvedValue(prismaUser('me'));

        const result = await routeCommand(fakeClient('me'), {
            command: 'star',
            payload: { candidateId: 'other' }
        } as never);

        expect(mockConversationCreate).toHaveBeenCalled();
        expect((result as { payload: { success: boolean } }).payload.success).toBe(true);
    });

    it('returns error payload on failure', async () => {
        mockMatchUpsert.mockRejectedValue(new Error('fail'));

        const result = await routeCommand(fakeClient(), {
            command: 'star',
            payload: { candidateId: 'other' }
        } as never);

        expect(result).toEqual(
            expect.objectContaining({ payload: expect.objectContaining({ error: 'Internal error' }) })
        );
    });
});
