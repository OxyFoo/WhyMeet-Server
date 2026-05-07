const mockUserFindUnique = jest.fn();
const mockSearchQuotaFindUnique = jest.fn();
const mockSearchQuotaCreate = jest.fn();
const mockSearchQuotaUpdate = jest.fn();
const mockSwipeQuotaFindUnique = jest.fn();
const mockSwipeQuotaCreate = jest.fn();
const mockSwipeQuotaUpdate = jest.fn();
const mockActivityQuotaFindUnique = jest.fn();
const mockActivityQuotaCreate = jest.fn();
const mockActivityQuotaUpdate = jest.fn();
const mockAppConfigFindMany = jest.fn();

jest.mock('@/services/database', () => ({
    getDatabase: () => ({
        user: { findUnique: mockUserFindUnique },
        searchQuota: {
            findUnique: mockSearchQuotaFindUnique,
            create: mockSearchQuotaCreate,
            update: mockSearchQuotaUpdate
        },
        swipeQuota: {
            findUnique: mockSwipeQuotaFindUnique,
            create: mockSwipeQuotaCreate,
            update: mockSwipeQuotaUpdate
        },
        activityQuota: {
            findUnique: mockActivityQuotaFindUnique,
            create: mockActivityQuotaCreate,
            update: mockActivityQuotaUpdate
        },
        appConfig: { findMany: mockAppConfigFindMany }
    })
}));

const mockIsPremium = jest.fn();
jest.mock('@/services/subscriptionService', () => ({ isPremium: mockIsPremium }));

import { addSearchTokens, getSearchQuota, useSearchQuota } from '@/services/searchQuotaService';
import { canSwipe, getSwipeQuota, useSwipeQuota } from '@/services/swipeQuotaService';
import { getActivityQuota, useActivityQuota } from '@/services/activityQuotaService';
import { clearUsageLimitConfigCache } from '@/services/usageLimitsService';

describe('bot quota exemption', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        clearUsageLimitConfigCache();
        mockUserFindUnique.mockResolvedValue({ bot: true });
        mockAppConfigFindMany.mockResolvedValue([]);
    });

    it('makes search, swipe and activity quotas unlimited for bots', async () => {
        await expect(getSearchQuota('bot-1')).resolves.toEqual({ remaining: -1, dailyLimit: -1 });
        await expect(useSearchQuota('bot-1')).resolves.toEqual({ remaining: -1, dailyLimit: -1 });
        await expect(addSearchTokens('bot-1', 10)).resolves.toEqual({ remaining: -1, dailyLimit: -1 });

        await expect(getSwipeQuota('bot-1')).resolves.toEqual({ remaining: -1, dailyLimit: -1 });
        await expect(useSwipeQuota('bot-1')).resolves.toEqual({ remaining: -1, dailyLimit: -1 });
        await expect(canSwipe('bot-1')).resolves.toBe(true);

        await expect(getActivityQuota('bot-1')).resolves.toEqual({ remaining: -1, dailyLimit: -1 });
        await expect(useActivityQuota('bot-1')).resolves.toEqual({ remaining: -1, dailyLimit: -1 });

        expect(mockSearchQuotaFindUnique).not.toHaveBeenCalled();
        expect(mockSearchQuotaCreate).not.toHaveBeenCalled();
        expect(mockSearchQuotaUpdate).not.toHaveBeenCalled();
        expect(mockSwipeQuotaFindUnique).not.toHaveBeenCalled();
        expect(mockSwipeQuotaCreate).not.toHaveBeenCalled();
        expect(mockSwipeQuotaUpdate).not.toHaveBeenCalled();
        expect(mockActivityQuotaFindUnique).not.toHaveBeenCalled();
        expect(mockActivityQuotaCreate).not.toHaveBeenCalled();
        expect(mockActivityQuotaUpdate).not.toHaveBeenCalled();
        expect(mockIsPremium).not.toHaveBeenCalled();
        expect(mockUserFindUnique).toHaveBeenCalledTimes(1);
        expect(mockAppConfigFindMany).toHaveBeenCalledTimes(1);
    });
});
