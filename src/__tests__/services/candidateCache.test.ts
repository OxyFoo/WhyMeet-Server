const mockMget = jest.fn();
const mockSet = jest.fn();
const mockExec = jest.fn();
const mockPipeline = { set: mockSet, exec: mockExec };
const mockRedis = {
    mget: mockMget,
    pipeline: jest.fn(() => mockPipeline),
    del: jest.fn()
};

jest.mock('@/services/redisService', () => ({
    getRedis: () => mockRedis,
    isRedisAvailable: () => true
}));

jest.mock('@/config/env', () => ({
    env: { REDIS_TTL_CANDIDATE_S: 300 }
}));

jest.mock('@/config/logger', () => ({
    logger: { warn: jest.fn(), debug: jest.fn() }
}));

import { getCandidates } from '@/services/candidateCache';

describe('candidateCache', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('revives nested badge dates from Redis payloads', async () => {
        const birthDate = '2000-01-15T00:00:00.000Z';
        const earnedAt = '2026-05-07T19:49:00.000Z';
        const rewardClaimedAt = '2026-05-07T19:50:00.000Z';

        mockMget.mockResolvedValue([
            JSON.stringify({
                id: 'user-1',
                birthDate,
                badges: [
                    {
                        badgeKey: 'verified_profile',
                        earned: true,
                        earnedAt,
                        rewardClaimedAt,
                        definition: { displayOrder: 1 }
                    }
                ]
            })
        ]);

        const candidates = await getCandidates(['user-1']);
        const user = candidates.get('user-1') as {
            birthDate: unknown;
            badges: { earnedAt: unknown; rewardClaimedAt: unknown }[];
        };

        expect(user.birthDate).toBeInstanceOf(Date);
        expect(user.badges[0].earnedAt).toBeInstanceOf(Date);
        expect(user.badges[0].rewardClaimedAt).toBeInstanceOf(Date);
        expect((user.badges[0].earnedAt as Date).toISOString()).toBe(earnedAt);
    });
});
