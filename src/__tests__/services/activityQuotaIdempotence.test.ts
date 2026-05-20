const mockActivityOpenCreate = jest.fn();
const mockActivityQuotaFindUnique = jest.fn();
const mockActivityQuotaCreate = jest.fn();
const mockActivityQuotaUpdate = jest.fn();
const mockUserFindUnique = jest.fn();
const mockAppConfigFindMany = jest.fn();

jest.mock('@/services/database', () => ({
    getDatabase: () => ({
        user: { findUnique: mockUserFindUnique },
        activityQuota: {
            findUnique: mockActivityQuotaFindUnique,
            create: mockActivityQuotaCreate,
            update: mockActivityQuotaUpdate
        },
        activityOpen: { create: mockActivityOpenCreate },
        appConfig: { findMany: mockAppConfigFindMany }
    })
}));

const mockGetActivityOpenDailyLimit = jest.fn();
jest.mock('@/services/usageLimitsService', () => ({
    getActivityOpenDailyLimit: (...args: unknown[]) => mockGetActivityOpenDailyLimit(...args)
}));

import { useActivityQuotaOnFirstOpen } from '@/services/activityQuotaService';

describe('useActivityQuotaOnFirstOpen', () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

    beforeEach(() => {
        jest.clearAllMocks();
        mockUserFindUnique.mockResolvedValue({ bot: false });
        mockAppConfigFindMany.mockResolvedValue([]);
        mockGetActivityOpenDailyLimit.mockResolvedValue(3);
        mockActivityQuotaFindUnique.mockResolvedValue({ userId: 'u1', remaining: 3, resetAt: future });
    });

    it('debits the quota the first time an activity is opened on a given day', async () => {
        mockActivityOpenCreate.mockResolvedValue({ id: 'o1' });
        mockActivityQuotaUpdate.mockResolvedValue({ remaining: 2 });

        const result = await useActivityQuotaOnFirstOpen('u1', 'a1');

        expect(mockActivityOpenCreate).toHaveBeenCalledTimes(1);
        expect(mockActivityQuotaUpdate).toHaveBeenCalledTimes(1);
        expect(result.remaining).toBe(2);
    });

    it('does not re-debit on a second open of the same activity on the same day', async () => {
        const conflict = new Error(
            'Invalid `prisma.activityOpen.create()` invocation: Unique constraint failed on the fields: (`userId`,`activityId`,`day`)'
        );
        mockActivityOpenCreate.mockRejectedValue(conflict);

        const result = await useActivityQuotaOnFirstOpen('u1', 'a1');

        expect(mockActivityOpenCreate).toHaveBeenCalledTimes(1);
        expect(mockActivityQuotaUpdate).not.toHaveBeenCalled();
        expect(result.remaining).toBe(3);
    });
});
