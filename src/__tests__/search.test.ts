// ─── Mocks ──────────────────────────────────────────────────────────

jest.mock('@/config/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), success: jest.fn() }
}));

const mockFindMany = jest.fn();
const mockFindUnique = jest.fn();
const mockBlockFindMany = jest.fn();
const mockReportFindMany = jest.fn();
jest.mock('@/services/database', () => ({
    getDatabase: () => ({
        user: { findMany: mockFindMany, findUnique: mockFindUnique },
        block: { findMany: mockBlockFindMany },
        report: { findMany: mockReportFindMany }
    })
}));

// Import command to trigger registerCommand side-effect
import '@/commands/search/search';
import { routeCommand } from '@/server/Router';
import type { Client } from '@/server/Client';

function fakeClient(userId = 'me'): Client {
    return { userId, id: 'c1', ip: '127.0.0.1', deviceId: 'd1' } as Client;
}

function prismaUser(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        name: 'User',
        age: 25,
        gender: 'female',
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
            intentions: ['dating'],
            spokenLanguages: ['fr']
        },
        tags: [{ type: 'interest', tag: { id: 't1', label: 'Hiking' } }],
        ...overrides
    };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('search command', () => {
    beforeEach(() => {
        mockFindMany.mockReset();
        mockFindUnique.mockReset();
        mockBlockFindMany.mockReset();
        mockReportFindMany.mockReset();
        mockFindUnique.mockResolvedValue({ profile: { latitude: null, longitude: null } });
        mockBlockFindMany.mockResolvedValue([]);
        mockReportFindMany.mockResolvedValue([]);
    });

    it('excludes the current user from results', async () => {
        mockFindMany.mockResolvedValue([]);

        await routeCommand(fakeClient('me'), {
            command: 'search',
            payload: { filters: {} }
        } as never);

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.id).toEqual({ notIn: ['me'] });
        expect(where.banned).toBe(false);
    });

    it('passes verified filter to query', async () => {
        mockFindMany.mockResolvedValue([]);

        await routeCommand(fakeClient(), {
            command: 'search',
            payload: { filters: { verified: true } }
        } as never);

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.verified).toBe(true);
    });

    it('passes ageRange filter as gte/lte', async () => {
        mockFindMany.mockResolvedValue([]);

        await routeCommand(fakeClient(), {
            command: 'search',
            payload: { filters: { ageRange: [20, 30] } }
        } as never);

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.age).toEqual({ gte: 20, lte: 30 });
    });

    it('passes query as name OR bio insensitive contains', async () => {
        mockFindMany.mockResolvedValue([]);

        await routeCommand(fakeClient(), {
            command: 'search',
            payload: { filters: { query: 'alice' } }
        } as never);

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.OR).toEqual([
            { name: { contains: 'alice', mode: 'insensitive' } },
            { profile: { bio: { contains: 'alice', mode: 'insensitive' } } }
        ]);
    });

    it('passes intentions filter as profile.intentions.hasSome', async () => {
        mockFindMany.mockResolvedValue([]);

        await routeCommand(fakeClient(), {
            command: 'search',
            payload: { filters: { intentions: ['friendship', 'dating'] } }
        } as never);

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.profile).toEqual(
            expect.objectContaining({
                intentions: { hasSome: ['friendship', 'dating'] }
            })
        );
    });

    it('passes tags filter as UserTag join', async () => {
        mockFindMany.mockResolvedValue([]);

        await routeCommand(fakeClient(), {
            command: 'search',
            payload: { filters: { tags: ['Yoga', 'Café'] } }
        } as never);

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.tags).toEqual({
            some: { tag: { label: { in: ['Yoga', 'Café'] } } }
        });
    });

    it('limits results to 100 (pre-filtering pool)', async () => {
        mockFindMany.mockResolvedValue([]);

        await routeCommand(fakeClient(), {
            command: 'search',
            payload: { filters: {} }
        } as never);

        expect(mockFindMany.mock.calls[0][0].take).toBe(100);
    });

    it('maps users to MatchCandidate format', async () => {
        mockFindMany.mockResolvedValue([prismaUser('u1')]);

        const result = await routeCommand(fakeClient(), {
            command: 'search',
            payload: { filters: {} }
        } as never);

        expect(result).toBeDefined();
        const payload = (result as { payload: { results: unknown[] } }).payload;
        expect(payload.results).toHaveLength(1);
        expect(payload.results[0]).toEqual(
            expect.objectContaining({
                id: 'u1',
                user: expect.objectContaining({ name: 'User' }),
                bio: 'bio',
                interests: ['Hiking'],
                skills: []
            })
        );
    });

    it('returns error payload on DB failure', async () => {
        mockFindMany.mockRejectedValue(new Error('DB down'));

        const result = await routeCommand(fakeClient(), {
            command: 'search',
            payload: { filters: {} }
        } as never);

        expect(result).toEqual(
            expect.objectContaining({ payload: expect.objectContaining({ error: 'Internal error' }) })
        );
    });
});
