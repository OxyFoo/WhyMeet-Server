import { isFeatureEnabled } from '@/services/featureFlagService';
import {
    isBotIsolationBypassUser,
    loadBotIsolationAccess,
    resolveCanBypassBotIsolation
} from '@/services/botIsolationService';

jest.mock('@/services/featureFlagService', () => ({
    isFeatureEnabled: jest.fn()
}));

const mockedIsFeatureEnabled = isFeatureEnabled as jest.MockedFunction<typeof isFeatureEnabled>;

describe('botIsolationService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('keeps isolation for non-allowlisted real viewers when safe mixing is enabled', () => {
        expect(
            resolveCanBypassBotIsolation({
                viewerIsBot: false,
                allowlistMixingEnabled: true,
                globalMixingEnabled: false,
                viewerAllowlisted: false
            })
        ).toBe(false);
    });

    it('allows an allowlisted real viewer when safe mixing is enabled', () => {
        expect(
            resolveCanBypassBotIsolation({
                viewerIsBot: false,
                allowlistMixingEnabled: true,
                globalMixingEnabled: false,
                viewerAllowlisted: true
            })
        ).toBe(true);
    });

    it('does not let a bot use the allowlist path', () => {
        expect(
            resolveCanBypassBotIsolation({
                viewerIsBot: true,
                allowlistMixingEnabled: true,
                globalMixingEnabled: false,
                viewerAllowlisted: true
            })
        ).toBe(false);
    });

    it('allows everyone through the explicit global mode', () => {
        expect(
            resolveCanBypassBotIsolation({
                viewerIsBot: true,
                allowlistMixingEnabled: false,
                globalMixingEnabled: true,
                viewerAllowlisted: false
            })
        ).toBe(true);
    });

    it('checks bypass rows by userId', async () => {
        const findUnique = jest.fn().mockResolvedValue({ id: 'bypass-1' });
        const db = { botIsolationBypassUser: { findUnique } };

        await expect(isBotIsolationBypassUser(db as never, 'user-1')).resolves.toBe(true);

        expect(findUnique).toHaveBeenCalledWith({
            where: { userId: 'user-1' },
            select: { id: true }
        });
    });

    it('loads flags and allowlist state into an effective access decision', async () => {
        mockedIsFeatureEnabled.mockImplementation(async (key) => key === 'stresstest.bot_user_mixing');
        const db = { botIsolationBypassUser: { findUnique: jest.fn().mockResolvedValue({ id: 'bypass-1' }) } };

        await expect(loadBotIsolationAccess('user-1', false, db as never)).resolves.toEqual({
            allowlistMixingEnabled: true,
            globalMixingEnabled: false,
            viewerAllowlisted: true,
            canBypassBotIsolation: true
        });
    });
});
