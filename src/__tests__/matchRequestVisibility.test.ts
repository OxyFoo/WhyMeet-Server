// ─── Mocks ──────────────────────────────────────────────────────────

const mockMatchFindMany = jest.fn();
const mockMatchCount = jest.fn();
const mockBlockFindMany = jest.fn();
const mockConversationParticipantAggregate = jest.fn();
const mockNotificationCount = jest.fn();

jest.mock('@/services/database', () => ({
    getDatabase: () => ({
        match: { findMany: mockMatchFindMany, count: mockMatchCount },
        block: { findMany: mockBlockFindMany },
        conversationParticipant: { aggregate: mockConversationParticipantAggregate },
        notification: { count: mockNotificationCount }
    })
}));

jest.mock('@/server/Server', () => ({
    getClientsForUser: () => []
}));

jest.mock('@/config/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), success: jest.fn() }
}));

import { getHiddenIncomingRequestSenderIds, incomingRequestVisibilityFilter } from '@/services/matchRequestVisibility';
import { getUserCounters } from '@/services/userCounters';

const ME = 'user-me';

beforeEach(() => {
    jest.clearAllMocks();
});

describe('getHiddenIncomingRequestSenderIds', () => {
    test('excludes users I have already acted on, regardless of match category', async () => {
        mockMatchFindMany.mockResolvedValueOnce([{ receiverId: 'liked-user' }, { receiverId: 'skipped-user' }]);
        mockBlockFindMany.mockResolvedValueOnce([]);

        const hidden = await getHiddenIncomingRequestSenderIds(ME);

        expect(new Set(hidden)).toEqual(new Set(['liked-user', 'skipped-user']));
        // Sanity: query is scoped to my outgoing matches only.
        expect(mockMatchFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { senderId: ME } }));
        // And dedupes at the DB level.
        expect(mockMatchFindMany).toHaveBeenCalledWith(expect.objectContaining({ distinct: ['receiverId'] }));
    });

    test('excludes both directions of a block relationship', async () => {
        mockMatchFindMany.mockResolvedValueOnce([]);
        mockBlockFindMany.mockResolvedValueOnce([
            { blockerId: ME, blockedId: 'i-blocked' },
            { blockerId: 'they-blocked-me', blockedId: ME }
        ]);

        const hidden = await getHiddenIncomingRequestSenderIds(ME);

        expect(new Set(hidden)).toEqual(new Set(['i-blocked', 'they-blocked-me']));
    });

    test('merges acted-on senders + block counterparties without duplicates', async () => {
        mockMatchFindMany.mockResolvedValueOnce([{ receiverId: 'overlap-user' }, { receiverId: 'only-match' }]);
        mockBlockFindMany.mockResolvedValueOnce([
            { blockerId: ME, blockedId: 'overlap-user' },
            { blockerId: 'only-block', blockedId: ME }
        ]);

        const hidden = await getHiddenIncomingRequestSenderIds(ME);

        expect(new Set(hidden)).toEqual(new Set(['overlap-user', 'only-match', 'only-block']));
        expect(hidden).toHaveLength(3);
    });
});

describe('incomingRequestVisibilityFilter', () => {
    test('returns empty filter when no senders to hide', () => {
        expect(incomingRequestVisibilityFilter([])).toEqual({});
    });

    test('returns a notIn filter when senders are hidden', () => {
        expect(incomingRequestVisibilityFilter(['a', 'b'])).toEqual({ senderId: { notIn: ['a', 'b'] } });
    });
});

describe('getUserCounters → parité avec le filtre de get-requests', () => {
    test('forwards the same hidden-sender list to pendingMatchRequests count', async () => {
        mockConversationParticipantAggregate.mockResolvedValueOnce({ _sum: { unreadCount: 4 } });
        mockNotificationCount.mockResolvedValueOnce(2);
        // getHiddenIncomingRequestSenderIds
        mockMatchFindMany.mockResolvedValueOnce([{ receiverId: 'acted-on' }]);
        mockBlockFindMany.mockResolvedValueOnce([{ blockerId: 'blocker', blockedId: ME }]);
        // pendingMatchRequests count
        mockMatchCount.mockResolvedValueOnce(3);

        const counters = await getUserCounters(ME);

        expect(counters).toEqual({
            unreadConversations: 4,
            pendingMatchRequests: 3,
            unreadNotifications: 2
        });

        // The count query must apply the same visibility filter that
        // `get-requests` uses, otherwise badge and list will drift apart.
        const countArgs = mockMatchCount.mock.calls[0][0];
        expect(countArgs.where).toMatchObject({
            receiverId: ME,
            category: 'like',
            mutual: false,
            sender: { banned: false, suspended: false, deleted: false },
            senderId: { notIn: expect.arrayContaining(['acted-on', 'blocker']) }
        });
    });

    test('omits the notIn clause entirely when nothing is hidden', async () => {
        mockConversationParticipantAggregate.mockResolvedValueOnce({ _sum: { unreadCount: 0 } });
        mockNotificationCount.mockResolvedValueOnce(0);
        mockMatchFindMany.mockResolvedValueOnce([]);
        mockBlockFindMany.mockResolvedValueOnce([]);
        mockMatchCount.mockResolvedValueOnce(7);

        await getUserCounters(ME);

        const countArgs = mockMatchCount.mock.calls[0][0];
        expect(countArgs.where).not.toHaveProperty('senderId');
    });

    test('treats null aggregate as 0 unreadConversations', async () => {
        mockConversationParticipantAggregate.mockResolvedValueOnce({ _sum: { unreadCount: null } });
        mockNotificationCount.mockResolvedValueOnce(0);
        mockMatchFindMany.mockResolvedValueOnce([]);
        mockBlockFindMany.mockResolvedValueOnce([]);
        mockMatchCount.mockResolvedValueOnce(0);

        const counters = await getUserCounters(ME);

        expect(counters.unreadConversations).toBe(0);
    });
});
