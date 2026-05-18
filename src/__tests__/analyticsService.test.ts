jest.mock('@/config/logger', () => ({
    logger: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        success: jest.fn()
    }
}));

const createMany = jest.fn();
jest.mock('@/services/database', () => ({
    getDatabase: () => ({
        analyticsEvent: { createMany }
    })
}));

import { recordEvents } from '@/services/analyticsService';
import type { AnalyticsClientEvent } from '@oxyfoo/whymeet-types';
import { ANALYTICS_MAX_EVENTS_PER_BATCH } from '@oxyfoo/whymeet-types';

function makeEvent(overrides: Partial<AnalyticsClientEvent> = {}): AnalyticsClientEvent {
    return {
        name: 'screen_view',
        ts: Date.now(),
        platform: 'ios',
        appVersion: '1.0.0',
        props: { screen: 'Home' },
        ...overrides
    } as AnalyticsClientEvent;
}

describe('analyticsService.recordEvents', () => {
    beforeEach(() => {
        createMany.mockReset();
        createMany.mockResolvedValue({ count: 0 });
    });

    it('returns 0/0 for empty batch and never calls DB', async () => {
        const res = await recordEvents('dev-1', []);
        expect(res).toEqual({ accepted: 0, rejected: 0 });
        expect(createMany).not.toHaveBeenCalled();
    });

    it('accepts a valid batch and inserts via createMany', async () => {
        const res = await recordEvents('dev-1', [
            makeEvent(),
            makeEvent({ name: 'feature.match.like', props: undefined })
        ]);
        expect(res).toEqual({ accepted: 2, rejected: 0 });
        expect(createMany).toHaveBeenCalledTimes(1);
        const arg = createMany.mock.calls[0][0];
        expect(arg.data).toHaveLength(2);
        expect(arg.data[0].deviceId).toBe('dev-1');
    });

    it('rejects events with unknown name', async () => {
        const res = await recordEvents('dev-1', [makeEvent({ name: 'feature.bogus' as never })]);
        expect(res).toEqual({ accepted: 0, rejected: 1 });
        expect(createMany).not.toHaveBeenCalled();
    });

    it('rejects events with invalid shape', async () => {
        const res = await recordEvents('dev-1', [{ not: 'an event' }, null, undefined, 42]);
        expect(res.accepted).toBe(0);
        expect(res.rejected).toBe(4);
    });

    it('drops events whose props exceed the size budget', async () => {
        const huge = 'x'.repeat(3000);
        const res = await recordEvents('dev-1', [makeEvent({ props: { screen: huge } })]);
        expect(res).toEqual({ accepted: 0, rejected: 1 });
    });

    it('caps oversized batches at ANALYTICS_MAX_EVENTS_PER_BATCH', async () => {
        const batch = Array.from({ length: ANALYTICS_MAX_EVENTS_PER_BATCH + 10 }, () => makeEvent());
        const res = await recordEvents('dev-1', batch);
        expect(res.accepted).toBe(ANALYTICS_MAX_EVENTS_PER_BATCH);
        expect(res.rejected).toBe(10);
    });

    it('never throws when the DB call fails — returns accepted=0 and logs warn', async () => {
        createMany.mockRejectedValueOnce(new Error('DB down'));
        const res = await recordEvents('dev-1', [makeEvent()]);
        expect(res).toEqual({ accepted: 0, rejected: 1 });
    });
});
