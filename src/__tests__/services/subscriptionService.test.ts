const mockPremiumOverrideFindUnique = jest.fn();
const mockPremiumOverrideFindMany = jest.fn();
const mockSubscriptionFindUnique = jest.fn();
const mockSubscriptionFindMany = jest.fn();
const mockSubscriptionUpdate = jest.fn();

jest.mock('@/config/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), success: jest.fn() }
}));

jest.mock('@/services/boostService', () => ({
    grantSubscriptionBoost: jest.fn()
}));

jest.mock('@/services/database', () => ({
    getDatabase: () => ({
        premiumOverride: { findUnique: mockPremiumOverrideFindUnique, findMany: mockPremiumOverrideFindMany },
        subscription: {
            findUnique: mockSubscriptionFindUnique,
            findMany: mockSubscriptionFindMany,
            update: mockSubscriptionUpdate
        }
    })
}));

import { isPremium, getSubscription, computeExpiryDate, getPremiumUserIds } from '@/services/subscriptionService';

describe('subscriptionService.isPremium', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockPremiumOverrideFindUnique.mockResolvedValue(null);
        mockSubscriptionFindUnique.mockResolvedValue(null);
    });

    it('returns true when a positive premium override is active', async () => {
        mockPremiumOverrideFindUnique.mockResolvedValue({
            forcedPremium: true,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
        });

        await expect(isPremium('user-1')).resolves.toBe(true);
        expect(mockSubscriptionFindUnique).not.toHaveBeenCalled();
    });

    it('returns false when a negative premium override is active even with a paid subscription', async () => {
        mockPremiumOverrideFindUnique.mockResolvedValue({
            forcedPremium: false,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
        });
        mockSubscriptionFindUnique.mockResolvedValue({
            status: 'active',
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        });

        await expect(isPremium('user-1')).resolves.toBe(false);
        expect(mockSubscriptionFindUnique).not.toHaveBeenCalled();
    });

    it('falls back to an active subscription when the override is expired', async () => {
        mockPremiumOverrideFindUnique.mockResolvedValue({
            forcedPremium: false,
            expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000)
        });
        mockSubscriptionFindUnique.mockResolvedValue({
            status: 'active',
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        });

        await expect(isPremium('user-1')).resolves.toBe(true);
        expect(mockSubscriptionFindUnique).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    });

    it('returns false without active override or subscription', async () => {
        await expect(isPremium('user-1')).resolves.toBe(false);
        expect(mockSubscriptionFindUnique).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    });
});

describe('subscriptionService.getSubscription grace period', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockSubscriptionUpdate.mockImplementation(({ data }) => Promise.resolve({ ...data }));
    });

    it('transitions active subscription past expiry into grace_period', async () => {
        const expiredAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
        mockSubscriptionFindUnique.mockResolvedValue({
            plan: 'monthly',
            status: 'active',
            platform: 'ios',
            expiresAt: expiredAt,
            cancelledAt: null
        });

        const sub = await getSubscription('user-1');
        expect(sub?.status).toBe('grace_period');
        expect(mockSubscriptionUpdate).toHaveBeenCalledWith({
            where: { userId: 'user-1' },
            data: { status: 'grace_period' }
        });
    });

    it('flips grace_period to expired after the grace window', async () => {
        const veryOld = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        mockSubscriptionFindUnique.mockResolvedValue({
            plan: 'monthly',
            status: 'grace_period',
            platform: 'ios',
            expiresAt: veryOld,
            cancelledAt: null
        });

        const sub = await getSubscription('user-1');
        expect(sub?.status).toBe('expired');
    });

    it('keeps active subscription untouched before expiry', async () => {
        mockSubscriptionFindUnique.mockResolvedValue({
            plan: 'annual',
            status: 'active',
            platform: 'android',
            expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
            cancelledAt: null
        });

        const sub = await getSubscription('user-1');
        expect(sub?.status).toBe('active');
        expect(mockSubscriptionUpdate).not.toHaveBeenCalled();
    });
});

describe('subscriptionService.computeExpiryDate', () => {
    it('handles month-end overflow (Jan 31 + 1 month → Feb 28/29)', () => {
        const jan31 = new Date(2025, 0, 31, 12, 0, 0);
        const result = computeExpiryDate('monthly', jan31);
        expect(result.getMonth()).toBe(1); // February
        expect([28, 29]).toContain(result.getDate());
    });

    it('adds 12 months for annual plans', () => {
        const day = new Date(2024, 2, 15, 12, 0, 0); // 2024-03-15
        const result = computeExpiryDate('annual', day);
        expect(result.getFullYear()).toBe(2025);
        expect(result.getMonth()).toBe(2);
        expect(result.getDate()).toBe(15);
    });

    it('adds 6 months for semi_annual plans', () => {
        const day = new Date(2024, 5, 10, 0, 0, 0); // 2024-06-10
        const result = computeExpiryDate('semi_annual', day);
        expect(result.getMonth()).toBe(11); // December
        expect(result.getDate()).toBe(10);
    });
});

describe('subscriptionService.getPremiumUserIds', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockPremiumOverrideFindMany.mockResolvedValue([]);
        mockSubscriptionFindMany.mockResolvedValue([]);
    });

    it('returns empty set for empty input without hitting DB', async () => {
        await expect(getPremiumUserIds([])).resolves.toEqual(new Set());
        expect(mockSubscriptionFindMany).not.toHaveBeenCalled();
    });

    it('includes users with active subscription and excludes negative overrides', async () => {
        mockSubscriptionFindMany.mockResolvedValue([{ userId: 'a' }, { userId: 'b' }]);
        mockPremiumOverrideFindMany.mockResolvedValue([{ userId: 'b', forcedPremium: false }]);

        const result = await getPremiumUserIds(['a', 'b', 'c']);
        expect(result.has('a')).toBe(true);
        expect(result.has('b')).toBe(false);
        expect(result.has('c')).toBe(false);
    });

    it('includes users with positive override regardless of subscription', async () => {
        mockSubscriptionFindMany.mockResolvedValue([]);
        mockPremiumOverrideFindMany.mockResolvedValue([{ userId: 'd', forcedPremium: true }]);

        const result = await getPremiumUserIds(['d']);
        expect(result.has('d')).toBe(true);
    });
});
