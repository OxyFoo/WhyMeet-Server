// ─── Mocks ──────────────────────────────────────────────────────────

jest.mock('@/config/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), success: jest.fn() }
}));

jest.mock('@/services/searchQuotaService', () => ({
    getSearchQuota: jest.fn().mockResolvedValue({ remaining: 5, dailyLimit: 3 })
}));

const mockGetBoostedUserIds = jest.fn().mockResolvedValue(new Set<string>());
jest.mock('@/services/boostService', () => ({
    getBoostedUserIds: () => mockGetBoostedUserIds()
}));

const mockInterleaveByBoost = jest.fn().mockImplementation((candidates: unknown[]) => candidates);
jest.mock('@/services/interleaveResults', () => ({
    interleaveByBoost: (candidates: unknown[], boostedIds: Set<string>) => mockInterleaveByBoost(candidates, boostedIds)
}));

const mockRunDiscoveryPipeline = jest.fn();
jest.mock('@/services/discoveryPipeline', () => ({
    runDiscoveryPipeline: (...args: unknown[]) => mockRunDiscoveryPipeline(...args)
}));

const mockMapUserToCandidate = jest.fn();
jest.mock('@/services/userMapper', () => ({
    mapUserToCandidate: (...args: unknown[]) => mockMapUserToCandidate(...args)
}));

const mockEnrichProfileIntentionsFromFilters = jest.fn().mockResolvedValue(undefined);
jest.mock('@/services/intentionProfileEnrichment', () => ({
    enrichProfileIntentionsFromFilters: (...args: unknown[]) => mockEnrichProfileIntentionsFromFilters(...args)
}));

// Import command to trigger registerCommand side-effect
import '@/commands/search/search';
import { routeCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { MatchCandidate, SearchFilters } from '@oxyfoo/whymeet-types';

function fakeClient(userId = 'me'): Client {
    return { userId, id: 'c1', ip: '127.0.0.1', deviceId: 'd1' } as Client;
}

function candidate(id: string): MatchCandidate {
    return {
        id,
        user: {
            id,
            name: 'User',
            age: 25,
            birthDate: '2000-01-01T00:00:00.000Z',
            gender: 'female',
            photos: [],
            city: 'Paris',
            verified: true,
            suspended: false,
            banned: false,
            preferredPeriod: 'any',
            isPremium: false,
            isBoosted: false,
            badges: []
        },
        bio: 'bio',
        intentionKeys: ['meet_simple_first_date'],
        interests: ['Hiking'],
        skills: [],
        distance: ''
    };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('search command', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockRunDiscoveryPipeline.mockResolvedValue({
            qualified: [],
            ctx: { prefIntentionKeys: ['meet_simple_first_date'], myLatLng: null }
        });
        mockMapUserToCandidate.mockImplementation((user: { id: string }) => candidate(user.id));
    });

    it('delegates filters to the discovery pipeline', async () => {
        const filters: SearchFilters = {
            categoryKey: 'see_if_it_clicks',
            intentionKey: 'meet_simple_first_date',
            tags: ['Yoga'],
            verified: true
        };

        await routeCommand(fakeClient('me'), {
            command: 'search',
            payload: { filters }
        } as never);

        expect(mockRunDiscoveryPipeline).toHaveBeenCalledWith(fakeClient('me'), filters, 1000);
    });

    it('rejects incoherent category and intention filters', async () => {
        const result = await routeCommand(fakeClient('me'), {
            command: 'search',
            payload: {
                filters: {
                    categoryKey: 'build_connection',
                    intentionKey: 'meet_simple_first_date'
                }
            }
        } as never);

        expect(result).toEqual(
            expect.objectContaining({ payload: expect.objectContaining({ error: 'Invalid field: intentionKey' }) })
        );
        expect(mockRunDiscoveryPipeline).not.toHaveBeenCalled();
    });

    it('maps qualified users to MatchCandidate results with score and context match', async () => {
        const intentionMatch = {
            categoryKey: 'see_if_it_clicks',
            intentionKey: 'meet_simple_first_date',
            label: 'Simple first meet',
            reasons: ['same context'],
            fallbackLevel: 'none'
        };
        mockRunDiscoveryPipeline.mockResolvedValue({
            qualified: [{ user: { id: 'u1' }, score: 82, intentionMatch }],
            ctx: { prefIntentionKeys: ['meet_simple_first_date'], myLatLng: { lat: 48.85, lng: 2.35 } }
        });

        const result = await routeCommand(fakeClient(), {
            command: 'search',
            payload: { filters: {} }
        } as never);

        const payload = (result as { payload: { results: MatchCandidate[]; totalCount: number; remaining: number } })
            .payload;
        expect(payload.results).toHaveLength(1);
        expect(payload.results[0]).toEqual(
            expect.objectContaining({
                id: 'u1',
                score: 82,
                intentionMatch
            })
        );
        expect(payload.totalCount).toBe(1);
        expect(payload.remaining).toBe(5);
        expect(mockMapUserToCandidate).toHaveBeenCalledWith({ id: 'u1' }, ['meet_simple_first_date'], {
            lat: 48.85,
            lng: 2.35
        });
    });

    it('interleaves boosted users before applying the result limit', async () => {
        const qualified = Array.from({ length: 30 }, (_, index) => ({ user: { id: `u${index}` }, score: 50 }));
        mockRunDiscoveryPipeline.mockResolvedValue({
            qualified,
            ctx: { prefIntentionKeys: [], myLatLng: null }
        });
        mockGetBoostedUserIds.mockResolvedValue(new Set(['u3']));

        const result = await routeCommand(fakeClient(), {
            command: 'search',
            payload: { filters: {} }
        } as never);

        const payload = (result as { payload: { results: MatchCandidate[]; totalCount: number } }).payload;
        expect(mockInterleaveByBoost).toHaveBeenCalledWith(expect.any(Array), new Set(['u3']));
        expect(payload.results).toHaveLength(25);
        expect(payload.totalCount).toBe(30);
    });

    it('returns error payload on pipeline failure', async () => {
        mockRunDiscoveryPipeline.mockRejectedValue(new Error('DB down'));

        const result = await routeCommand(fakeClient(), {
            command: 'search',
            payload: { filters: {} }
        } as never);

        expect(result).toEqual(
            expect.objectContaining({ payload: expect.objectContaining({ error: 'Internal error' }) })
        );
    });
});
