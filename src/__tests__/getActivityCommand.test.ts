jest.mock('@/config/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), success: jest.fn() }
}));

const mockGetActivity = jest.fn();
const mockUseActivityQuotaOnFirstOpen = jest.fn();

jest.mock('@/services/activityService', () => ({
    getActivity: (...args: unknown[]) => mockGetActivity(...args)
}));

jest.mock('@/services/activityQuotaService', () => ({
    useActivityQuotaOnFirstOpen: (...args: unknown[]) => mockUseActivityQuotaOnFirstOpen(...args)
}));

import '@/commands/activity/get-activity';
import { routeCommand } from '@/server/Router';
import type { Client } from '@/server/Client';

function fakeClient(userId = 'user-1'): Client {
    return { userId, id: 'c1', ip: '127.0.0.1', deviceId: 'd1' } as Client;
}

describe('get-activity command', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('does not consume activity quota for the host', async () => {
        const activity = { id: 'activity-1', isHost: true, isParticipant: false };
        mockGetActivity.mockResolvedValue(activity);

        const result = await routeCommand(fakeClient(), {
            command: 'get-activity',
            payload: { activityId: 'activity-1' }
        } as never);

        expect(mockUseActivityQuotaOnFirstOpen).not.toHaveBeenCalled();
        expect(result).toEqual({ command: 'get-activity', payload: { activity } });
    });

    it('does not consume activity quota for a participant', async () => {
        const activity = { id: 'activity-1', isHost: false, isParticipant: true };
        mockGetActivity.mockResolvedValue(activity);

        const result = await routeCommand(fakeClient(), {
            command: 'get-activity',
            payload: { activityId: 'activity-1' }
        } as never);

        expect(mockUseActivityQuotaOnFirstOpen).not.toHaveBeenCalled();
        expect(result).toEqual({ command: 'get-activity', payload: { activity } });
    });

    it('consumes activity quota for a viewer outside the activity (first open)', async () => {
        const activity = { id: 'activity-1', isHost: false, isParticipant: false };
        mockGetActivity.mockResolvedValue(activity);
        mockUseActivityQuotaOnFirstOpen.mockResolvedValue({ remaining: 2, dailyLimit: 3 });

        const result = await routeCommand(fakeClient(), {
            command: 'get-activity',
            payload: { activityId: 'activity-1' }
        } as never);

        expect(mockUseActivityQuotaOnFirstOpen).toHaveBeenCalledWith('user-1', 'activity-1');
        expect(result).toEqual({ command: 'get-activity', payload: { activity } });
    });

    it('delegates idempotence to useActivityQuotaOnFirstOpen on re-view of the same activity', async () => {
        const activity = { id: 'activity-1', isHost: false, isParticipant: false };
        mockGetActivity.mockResolvedValue(activity);
        mockUseActivityQuotaOnFirstOpen
            .mockResolvedValueOnce({ remaining: 2, dailyLimit: 3 })
            .mockResolvedValueOnce({ remaining: 2, dailyLimit: 3 });

        await routeCommand(fakeClient(), {
            command: 'get-activity',
            payload: { activityId: 'activity-1' }
        } as never);
        await routeCommand(fakeClient(), {
            command: 'get-activity',
            payload: { activityId: 'activity-1' }
        } as never);

        expect(mockUseActivityQuotaOnFirstOpen).toHaveBeenCalledTimes(2);
        expect(mockUseActivityQuotaOnFirstOpen).toHaveBeenNthCalledWith(1, 'user-1', 'activity-1');
        expect(mockUseActivityQuotaOnFirstOpen).toHaveBeenNthCalledWith(2, 'user-1', 'activity-1');
    });

    it('returns activity_quota_exceeded for a non-member when quota is exhausted', async () => {
        mockGetActivity.mockResolvedValue({ id: 'activity-1', isHost: false, isParticipant: false });
        mockUseActivityQuotaOnFirstOpen.mockRejectedValue(new Error('activity_quota_exceeded'));

        const result = await routeCommand(fakeClient(), {
            command: 'get-activity',
            payload: { activityId: 'activity-1' }
        } as never);

        expect(result).toEqual({ command: 'get-activity', payload: { error: 'activity_quota_exceeded' } });
    });
});
