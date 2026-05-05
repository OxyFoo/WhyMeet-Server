const mockPremiumOverrideFindUnique = jest.fn();
const mockSubscriptionFindUnique = jest.fn();

jest.mock('@/config/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), success: jest.fn() }
}));

jest.mock('@/services/boostService', () => ({
    grantSubscriptionBoost: jest.fn()
}));

jest.mock('@/services/database', () => ({
    getDatabase: () => ({
        premiumOverride: { findUnique: mockPremiumOverrideFindUnique },
        subscription: { findUnique: mockSubscriptionFindUnique }
    })
}));

import { isPremium } from '@/services/subscriptionService';

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
