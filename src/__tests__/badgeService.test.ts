jest.mock('@/services/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/config/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() }
}));

import { getDatabase } from '@/services/database';
import { checkAndAwardBadges, invalidateBadgeDefinitionsCache } from '@/services/badgeService';

const mockedGetDatabase = getDatabase as jest.MockedFunction<typeof getDatabase>;

function makeBadgeDb() {
    return {
        user: {
            findUniqueOrThrow: jest.fn().mockResolvedValue({ verified: true, createdAt: new Date('2025-01-01') })
        },
        profile: {
            findUnique: jest.fn().mockResolvedValue({ completedHostedCount: 0 })
        },
        activityParticipant: {
            count: jest.fn().mockResolvedValue(0)
        },
        badgeDefinition: {
            findMany: jest.fn().mockResolvedValue([
                {
                    key: 'verified_profile',
                    emoji: 'ok',
                    category: 'verification',
                    threshold: 1,
                    displayOrder: 1,
                    rewardType: null,
                    rewardOfferIdApple: null,
                    rewardOfferIdGoogle: null,
                    rewardDescription: null
                }
            ])
        },
        userBadge: {
            findMany: jest.fn().mockResolvedValue([]),
            upsert: jest.fn().mockReturnValue('badge-upsert')
        },
        $transaction: jest.fn().mockResolvedValue([])
    };
}

describe('badgeService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        invalidateBadgeDefinitionsCache();
    });

    it('upserts badge progress instead of creating duplicate-prone rows', async () => {
        const db = makeBadgeDb();
        mockedGetDatabase.mockReturnValue(db as never);

        await checkAndAwardBadges('user-badges');

        expect(db.userBadge.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId_badgeKey: { userId: 'user-badges', badgeKey: 'verified_profile' } },
                create: expect.objectContaining({
                    userId: 'user-badges',
                    badgeKey: 'verified_profile',
                    progress: 1,
                    earned: true,
                    earnedAt: expect.any(Date)
                }),
                update: expect.objectContaining({
                    progress: 1,
                    earned: true,
                    earnedAt: expect.any(Date)
                })
            })
        );
        expect(db.$transaction).toHaveBeenCalledWith(['badge-upsert']);
    });

    it('propagates persistence failures to callers that need fresh badges', async () => {
        const db = makeBadgeDb();
        db.$transaction.mockRejectedValue(new Error('database unavailable'));
        mockedGetDatabase.mockReturnValue(db as never);

        await expect(checkAndAwardBadges('user-badge-error')).rejects.toThrow('database unavailable');
    });
});
