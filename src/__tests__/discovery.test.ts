// ─── Mocks ──────────────────────────────────────────────────────────

jest.mock('@/config/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), success: jest.fn() }
}));

jest.mock('@/services/swipeQuotaService', () => ({
    getSwipeQuota: jest.fn().mockResolvedValue({ remaining: 20, dailyLimit: 20 }),
    useSwipeQuota: jest.fn().mockResolvedValue(undefined),
    canSwipe: jest.fn().mockResolvedValue(true)
}));

jest.mock('@/services/boostService', () => ({
    getBoostedUserIds: jest.fn().mockResolvedValue(new Set<string>())
}));

jest.mock('@/services/interleaveResults', () => ({
    interleaveByBoost: jest.fn().mockImplementation((candidates: unknown[]) => candidates)
}));

const mockEnrichProfileIntentionsFromFilters = jest.fn().mockResolvedValue(undefined);
jest.mock('@/services/intentionProfileEnrichment', () => ({
    enrichProfileIntentionsFromFilters: (...args: unknown[]) => mockEnrichProfileIntentionsFromFilters(...args)
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
const mockReportFindMany = jest.fn();

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
        settings: { findUnique: mockSettingsFindUnique },
        report: { findMany: mockReportFindMany }
    })
}));

const mockConnectedClients = new Map();
jest.mock('@/server/Server', () => ({
    getConnectedClients: () => mockConnectedClients,
    getClientsForUser: (userId: string) =>
        [...mockConnectedClients.values()].filter((client) => client.userId === userId),
    isUserConnected: (userId: string) => [...mockConnectedClients.values()].some((client) => client.userId === userId)
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

function prismaUser(
    id: string,
    intentionKeys: string[] = ['meet_simple_first_date'],
    tagLabels: string[] = ['Hiking']
) {
    const interests = [...tagLabels];
    while (interests.length < 5) interests.push(`${id}-interest-${interests.length}`);
    const skills = Array.from({ length: 5 }, (_, index) => `${id}-skill-${index}`);

    return {
        id,
        name: 'User',
        age: 25,
        birthDate: new Date('2000-01-01'),
        gender: 'female',
        photos: [{ id: `${id}-photo-1` }],
        city: 'Paris',
        verified: true,
        suspended: false,
        banned: false,
        preferredPeriod: 'any',
        profile: {
            bio: 'Une bio assez longue',
            socialVibe: 'balanced',
            country: 'FR',
            region: 'IDF',
            city: 'Paris',
            latitude: 48.8566,
            longitude: 2.3522,
            statConnections: 0,
            statMatches: 0,
            statVibes: 0,
            intentionKeys,
            spokenLanguages: ['fr']
        },
        tags: [
            ...interests.map((label, i) => ({
                id: `interest-${id}-${i}`,
                type: 'interest',
                label,
                labelLower: label.toLowerCase(),
                tag: { id: `interest-tag-${id}-${i}`, label }
            })),
            ...skills.map((label, i) => ({
                id: `skill-${id}-${i}`,
                type: 'skill',
                label,
                labelLower: label.toLowerCase(),
                tag: { id: `skill-tag-${id}-${i}`, label }
            }))
        ],
        _count: { receivedReports: 0 }
    };
}

// ─── get-candidates ─────────────────────────────────────────────────

describe('get-candidates command', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockBlockFindMany.mockResolvedValue([]);
        mockSettingsFindUnique.mockResolvedValue(null);
        mockReportFindMany.mockResolvedValue([]);
    });

    it('excludes current user and already-seen users', async () => {
        mockUserFindUnique.mockResolvedValue(prismaUser('me', ['meet_simple_first_date'], ['Yoga']));
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

    it('scores candidates using weighted scoring and sorts by total score', async () => {
        mockUserFindUnique.mockResolvedValue(
            prismaUser(
                'me',
                ['meet_simple_first_date', 'meet_make_acquaintance', 'build_collaboration'],
                ['Yoga', 'Café']
            )
        );
        mockMatchFindMany.mockResolvedValue([]);
        // candidate-A: 1/3 common contexts + 1/2 common tags
        // candidate-B: 3/3 common contexts + 0 common tags → higher context score dominates
        mockUserFindMany.mockResolvedValue([
            prismaUser('A', ['meet_simple_first_date'], ['Yoga']),
            prismaUser('B', ['meet_simple_first_date', 'meet_make_acquaintance', 'build_collaboration'], ['Surf'])
        ]);

        const result = await routeCommand(fakeClient('me'), {
            command: 'get-candidates',
            payload: {}
        } as never);

        const candidates = (result as { payload: { candidates: { id: string }[] } }).payload.candidates;
        expect(candidates.length).toBeGreaterThanOrEqual(2);
        // B has full context match vs A's partial match.
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

    it('stores the selected intention on the match record', async () => {
        mockMatchUpsert.mockResolvedValue({ id: 'm1' });
        mockMatchFindFirst.mockResolvedValue(null);

        await routeCommand(fakeClient('me'), {
            command: 'like',
            payload: {
                candidateId: 'other',
                selection: {
                    categoryKey: 'see_if_it_clicks',
                    intentionKey: 'meet_simple_first_date',
                    tags: ['Café']
                }
            }
        } as never);

        expect(mockMatchUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    categoryKey: 'see_if_it_clicks',
                    intentionKey: 'meet_simple_first_date'
                }),
                update: expect.objectContaining({
                    categoryKey: 'see_if_it_clicks',
                    intentionKey: 'meet_simple_first_date'
                })
            })
        );
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

    it('rejects incoherent intention selections', async () => {
        const result = await routeCommand(fakeClient('me'), {
            command: 'like',
            payload: {
                candidateId: 'other',
                selection: { categoryKey: 'build_connection', intentionKey: 'meet_simple_first_date' }
            }
        } as never);

        expect(result).toEqual(
            expect.objectContaining({
                payload: expect.objectContaining({ error: 'Invalid field: selection.intentionKey' })
            })
        );
        expect(mockMatchUpsert).not.toHaveBeenCalled();
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
