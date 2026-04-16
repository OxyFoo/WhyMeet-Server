// ─── Mocks ──────────────────────────────────────────────────────────

jest.mock('@/config/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), success: jest.fn() }
}));

const mockSettingsFindUnique = jest.fn();
const mockSettingsUpsert = jest.fn();

jest.mock('@/services/database', () => ({
    getDatabase: () => ({
        settings: {
            findUnique: mockSettingsFindUnique,
            upsert: mockSettingsUpsert
        }
    })
}));

// Import commands to trigger registerCommand side-effects
import '@/commands/settings/get-settings';
import '@/commands/settings/update-settings';
import { routeCommand } from '@/server/Router';
import type { Client } from '@/server/Client';

function fakeClient(userId = 'user-1'): Client {
    return { userId, id: 'c1', ip: '127.0.0.1', deviceId: 'd1' } as Client;
}

// ─── get-settings ───────────────────────────────────────────────────

describe('get-settings command', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('returns default settings when no settings record exists', async () => {
        mockSettingsFindUnique.mockResolvedValue(null);

        const result = await routeCommand(fakeClient(), {
            command: 'get-settings',
            payload: {}
        } as never);

        expect(result).toEqual({
            command: 'get-settings',
            payload: {
                settings: {
                    language: 'fr',
                    theme: 'light',
                    notifNewMatch: true,
                    notifLikes: true,
                    notifMessages: true,
                    notifNearbyPeople: true,
                    notifActivityReminder24h: true,
                    notifActivityReminder1h: true
                }
            }
        });
    });

    it('returns existing settings from the database', async () => {
        mockSettingsFindUnique.mockResolvedValue({
            language: 'en',
            theme: 'dark',
            notifNewMatch: true,
            notifLikes: false,
            notifMessages: true,
            notifNearbyPeople: true,
            notifActivityReminder24h: true,
            notifActivityReminder1h: true
        });

        const result = await routeCommand(fakeClient(), {
            command: 'get-settings',
            payload: {}
        } as never);

        expect(result).toEqual({
            command: 'get-settings',
            payload: {
                settings: {
                    language: 'en',
                    theme: 'dark',
                    notifNewMatch: true,
                    notifLikes: false,
                    notifMessages: true,
                    notifNearbyPeople: true,
                    notifActivityReminder24h: true,
                    notifActivityReminder1h: true
                }
            }
        });
    });

    it('returns error payload on DB failure', async () => {
        mockSettingsFindUnique.mockRejectedValue(new Error('DB down'));

        const result = await routeCommand(fakeClient(), {
            command: 'get-settings',
            payload: {}
        } as never);

        expect(result).toEqual(
            expect.objectContaining({ payload: expect.objectContaining({ error: 'Internal error' }) })
        );
    });
});

// ─── update-settings ─────────────────────────────────────────────────

describe('update-settings command', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('updates language only', async () => {
        mockSettingsUpsert.mockResolvedValue({
            language: 'en',
            theme: 'light',
            notifNewMatch: true,
            notifLikes: true,
            notifMessages: true,
            notifNearbyPeople: true,
            notifActivityReminder24h: true,
            notifActivityReminder1h: true
        });

        const result = await routeCommand(fakeClient(), {
            command: 'update-settings',
            payload: { data: { language: 'en' } }
        } as never);

        expect(mockSettingsUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                update: expect.objectContaining({ language: 'en' }),
                create: expect.objectContaining({ language: 'en', theme: 'light' })
            })
        );
        expect(result).toEqual({
            command: 'update-settings',
            payload: {
                settings: {
                    language: 'en',
                    theme: 'light',
                    notifNewMatch: true,
                    notifLikes: true,
                    notifMessages: true,
                    notifNearbyPeople: true,
                    notifActivityReminder24h: true,
                    notifActivityReminder1h: true
                }
            }
        });
    });

    it('updates theme only', async () => {
        mockSettingsUpsert.mockResolvedValue({
            language: 'fr',
            theme: 'dark',
            notifNewMatch: true,
            notifLikes: true,
            notifMessages: true,
            notifNearbyPeople: true,
            notifActivityReminder24h: true,
            notifActivityReminder1h: true
        });

        const result = await routeCommand(fakeClient(), {
            command: 'update-settings',
            payload: { data: { theme: 'dark' } }
        } as never);

        expect(mockSettingsUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                update: expect.objectContaining({ theme: 'dark' }),
                create: expect.objectContaining({ language: 'fr', theme: 'dark' })
            })
        );
        expect(result).toEqual({
            command: 'update-settings',
            payload: {
                settings: {
                    language: 'fr',
                    theme: 'dark',
                    notifNewMatch: true,
                    notifLikes: true,
                    notifMessages: true,
                    notifNearbyPeople: true,
                    notifActivityReminder24h: true,
                    notifActivityReminder1h: true
                }
            }
        });
    });

    it('updates both language and theme', async () => {
        mockSettingsUpsert.mockResolvedValue({
            language: 'en',
            theme: 'dark',
            notifNewMatch: true,
            notifLikes: true,
            notifMessages: true,
            notifNearbyPeople: true,
            notifActivityReminder24h: true,
            notifActivityReminder1h: true
        });

        const result = await routeCommand(fakeClient(), {
            command: 'update-settings',
            payload: { data: { language: 'en', theme: 'dark' } }
        } as never);

        expect(result).toEqual({
            command: 'update-settings',
            payload: {
                settings: {
                    language: 'en',
                    theme: 'dark',
                    notifNewMatch: true,
                    notifLikes: true,
                    notifMessages: true,
                    notifNearbyPeople: true,
                    notifActivityReminder24h: true,
                    notifActivityReminder1h: true
                }
            }
        });
    });

    it('rejects invalid language', async () => {
        const result = await routeCommand(fakeClient(), {
            command: 'update-settings',
            payload: { data: { language: 'de' } }
        } as never);

        expect(mockSettingsUpsert).not.toHaveBeenCalled();
        expect(result).toEqual({
            command: 'update-settings',
            payload: { error: 'Invalid language' }
        });
    });

    it('rejects uppercase language (case-sensitive)', async () => {
        const result = await routeCommand(fakeClient(), {
            command: 'update-settings',
            payload: { data: { language: 'FR' } }
        } as never);

        expect(mockSettingsUpsert).not.toHaveBeenCalled();
        expect(result).toEqual({
            command: 'update-settings',
            payload: { error: 'Invalid language' }
        });
    });

    it('rejects empty string language', async () => {
        const result = await routeCommand(fakeClient(), {
            command: 'update-settings',
            payload: { data: { language: '' } }
        } as never);

        expect(mockSettingsUpsert).not.toHaveBeenCalled();
        expect(result).toEqual({
            command: 'update-settings',
            payload: { error: 'Invalid language' }
        });
    });

    it('rejects invalid theme', async () => {
        const result = await routeCommand(fakeClient(), {
            command: 'update-settings',
            payload: { data: { theme: 'blue' } }
        } as never);

        expect(mockSettingsUpsert).not.toHaveBeenCalled();
        expect(result).toEqual({
            command: 'update-settings',
            payload: { error: 'Invalid theme' }
        });
    });

    it('rejects uppercase theme (case-sensitive)', async () => {
        const result = await routeCommand(fakeClient(), {
            command: 'update-settings',
            payload: { data: { theme: 'Dark' } }
        } as never);

        expect(mockSettingsUpsert).not.toHaveBeenCalled();
        expect(result).toEqual({
            command: 'update-settings',
            payload: { error: 'Invalid theme' }
        });
    });

    it('returns error when no settings fields are provided', async () => {
        const result = await routeCommand(fakeClient(), {
            command: 'update-settings',
            payload: { data: {} }
        } as never);

        expect(mockSettingsUpsert).not.toHaveBeenCalled();
        expect(result).toEqual({
            command: 'update-settings',
            payload: { error: 'No settings provided' }
        });
    });

    it('returns error payload on DB failure', async () => {
        mockSettingsUpsert.mockRejectedValue(new Error('DB down'));

        const result = await routeCommand(fakeClient(), {
            command: 'update-settings',
            payload: { data: { language: 'fr' } }
        } as never);

        expect(result).toEqual(
            expect.objectContaining({ payload: expect.objectContaining({ error: 'Internal error' }) })
        );
    });
});
