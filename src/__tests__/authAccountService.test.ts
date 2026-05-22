jest.mock('@/services/usageLimitsService', () => ({
    getUsageLimitConfig: jest.fn().mockResolvedValue({
        initialSearchTokens: 10,
        swipeDailyFree: 20,
        activityOpenDailyFree: 5
    })
}));

jest.mock('@/services/tokenManager', () => ({
    tokenManager: {
        hashToken: (t: string) => `hash:${t}`,
        session: { generate: () => 'fresh-session-token' }
    }
}));

import { findUserByEmail, recreateUser } from '@/services/authAccountService';
import { profileInclude } from '@/services/userMapper';

describe('authAccountService.findUserByEmail', () => {
    const findUnique = jest.fn();
    const db = { user: { findUnique } } as unknown as Parameters<typeof findUserByEmail>[0];

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('looks up the unique user by email with profile relations', async () => {
        const user = { id: 'u1', deleted: false };
        findUnique.mockResolvedValue(user);

        await expect(findUserByEmail(db, 'alice@example.com')).resolves.toBe(user);

        expect(findUnique).toHaveBeenCalledWith({
            where: { email: 'alice@example.com' },
            include: profileInclude
        });
    });

    it('returns null when no user matches', async () => {
        findUnique.mockResolvedValue(null);
        await expect(findUserByEmail(db, 'ghost@example.com')).resolves.toBeNull();
    });
});

describe('authAccountService.recreateUser', () => {
    const deleteCalls: Record<string, unknown[]> = {};
    const createCalls: Record<string, unknown[]> = {};
    const updateCalls: Record<string, unknown[]> = {};
    let userUpdate: jest.Mock;
    let deviceFindMany: jest.Mock;
    let deviceUpdate: jest.Mock;

    function makeTx() {
        const recordDelete = (model: string) => ({
            deleteMany: jest.fn(async (args: unknown) => {
                (deleteCalls[model] ||= []).push(args);
                return { count: 0 };
            })
        });
        const recordCreate = (model: string) => ({
            create: jest.fn(async (args: unknown) => {
                (createCalls[model] ||= []).push(args);
                return {};
            })
        });
        userUpdate = jest.fn(async (args: unknown) => {
            (updateCalls.user ||= []).push(args);
            return {};
        });
        deviceFindMany = jest.fn().mockResolvedValue([{ id: 'dev-1' }, { id: 'dev-2' }]);
        deviceUpdate = jest.fn(async (args: unknown) => {
            (updateCalls.device ||= []).push(args);
            return {};
        });

        return {
            userBadge: recordDelete('userBadge'),
            notification: recordDelete('notification'),
            message: recordDelete('message'),
            conversationParticipant: recordDelete('conversationParticipant'),
            match: recordDelete('match'),
            block: recordDelete('block'),
            activityParticipant: recordDelete('activityParticipant'),
            activityOpen: recordDelete('activityOpen'),
            activityReport: recordDelete('activityReport'),
            activity: recordDelete('activity'),
            subscription: recordDelete('subscription'),
            premiumOverride: recordDelete('premiumOverride'),
            activeBoost: recordDelete('activeBoost'),
            searchQuota: { ...recordDelete('searchQuota'), ...recordCreate('searchQuota') },
            swipeQuota: { ...recordDelete('swipeQuota'), ...recordCreate('swipeQuota') },
            activityQuota: { ...recordDelete('activityQuota'), ...recordCreate('activityQuota') },
            feedback: recordDelete('feedback'),
            profilePhoto: recordDelete('profilePhoto'),
            userTag: recordDelete('userTag'),
            profile: { ...recordDelete('profile'), ...recordCreate('profile') },
            settings: recordDelete('settings'),
            device: { findMany: deviceFindMany, update: deviceUpdate },
            user: { update: userUpdate }
        };
    }

    beforeEach(() => {
        for (const k of Object.keys(deleteCalls)) delete deleteCalls[k];
        for (const k of Object.keys(createCalls)) delete createCalls[k];
        for (const k of Object.keys(updateCalls)) delete updateCalls[k];
    });

    it('wipes per-user data, invalidates devices, resets user, and seeds fresh profile + quotas', async () => {
        const tx = makeTx();
        const db = {
            $transaction: jest.fn(async (cb: (t: typeof tx) => Promise<void>) => cb(tx))
        } as unknown as Parameters<typeof recreateUser>[0];

        await recreateUser(db, 'user-123', 'Alice');

        // Per-user data wiped (sampling the important ones)
        expect(deleteCalls.userBadge).toEqual([{ where: { userId: 'user-123' } }]);
        expect(deleteCalls.notification).toEqual([{ where: { userId: 'user-123' } }]);
        expect(deleteCalls.message).toEqual([{ where: { senderId: 'user-123' } }]);
        expect(deleteCalls.match).toEqual([{ where: { OR: [{ senderId: 'user-123' }, { receiverId: 'user-123' }] } }]);
        expect(deleteCalls.block).toEqual([{ where: { OR: [{ blockerId: 'user-123' }, { blockedId: 'user-123' }] } }]);
        expect(deleteCalls.activity).toEqual([{ where: { hostId: 'user-123' } }]);
        expect(deleteCalls.profile).toEqual([{ where: { userId: 'user-123' } }]);
        expect(deleteCalls.settings).toEqual([{ where: { userId: 'user-123' } }]);

        // Evidence rows are NOT touched
        expect(deleteCalls.ipLog).toBeUndefined();
        expect(deleteCalls.auditLog).toBeUndefined();
        expect(deleteCalls.report).toBeUndefined();
        expect(deleteCalls.suspiciousActivity).toBeUndefined();

        // Old devices invalidated (kept rows, rotated tokens)
        expect(deviceFindMany).toHaveBeenCalledWith({
            where: { userId: 'user-123' },
            select: { id: true }
        });
        expect(deviceUpdate).toHaveBeenCalledTimes(2);
        expect(deviceUpdate).toHaveBeenNthCalledWith(1, {
            where: { id: 'dev-1' },
            data: {
                sessionTokenHash: 'hash:fresh-session-token',
                mailTokenHash: null,
                status: 'pending',
                pushToken: null,
                pushProvider: null
            }
        });

        // User row reset (id + email preserved by the where clause)
        expect(updateCalls.user).toHaveLength(1);
        const userUpdateArg = updateCalls.user[0] as { where: unknown; data: Record<string, unknown> };
        expect(userUpdateArg.where).toEqual({ id: 'user-123' });
        expect(userUpdateArg.data.name).toBe('Alice');
        expect(userUpdateArg.data.deleted).toBe(false);
        expect(userUpdateArg.data.deletedAt).toBeNull();
        expect(userUpdateArg.data.banned).toBe(false);
        expect(userUpdateArg.data.suspended).toBe(false);
        expect(userUpdateArg.data.verified).toBe(false);
        expect(userUpdateArg.data.preferredPeriod).toBe('any');
        expect(userUpdateArg.data.recreatedAt).toBeInstanceOf(Date);
        // Critically: no `id` or `email` in the reset payload
        expect(userUpdateArg.data.id).toBeUndefined();
        expect(userUpdateArg.data.email).toBeUndefined();

        // Fresh profile + quotas (parity with signup)
        expect(createCalls.profile).toEqual([{ data: { userId: 'user-123', spokenLanguages: ['fr'] } }]);
        expect(createCalls.searchQuota?.[0]).toMatchObject({
            data: { userId: 'user-123', remaining: 10 }
        });
        expect(createCalls.swipeQuota?.[0]).toMatchObject({
            data: { userId: 'user-123', remaining: 20 }
        });
        expect(createCalls.activityQuota?.[0]).toMatchObject({
            data: { userId: 'user-123', remaining: 5 }
        });
    });
});
