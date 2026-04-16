import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_UpdateSettings, WSResponse_UpdateSettings, Language, Theme } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

const VALID_LANGUAGES: Language[] = ['fr', 'en'];
const VALID_THEMES: Theme[] = ['light', 'dark'];

const NOTIF_KEYS = [
    'notifNewMatch',
    'notifLikes',
    'notifMessages',
    'notifNearbyPeople',
    'notifActivityReminder24h',
    'notifActivityReminder1h'
] as const;

registerCommand<WSRequest_UpdateSettings>(
    'update-settings',
    async (client: Client, payload): Promise<WSResponse_UpdateSettings> => {
        const { data } = payload;
        const db = getDatabase();

        try {
            const hasLangOrTheme = data.language !== undefined || data.theme !== undefined;
            const hasNotif = NOTIF_KEYS.some((k) => data[k] !== undefined);

            if (!hasLangOrTheme && !hasNotif) {
                return { command: 'update-settings', payload: { error: 'No settings provided' } };
            }

            if (data.language !== undefined && !VALID_LANGUAGES.includes(data.language)) {
                return { command: 'update-settings', payload: { error: 'Invalid language' } };
            }

            if (data.theme !== undefined && !VALID_THEMES.includes(data.theme)) {
                return { command: 'update-settings', payload: { error: 'Invalid theme' } };
            }

            // Validate notif fields are booleans
            for (const k of NOTIF_KEYS) {
                if (data[k] !== undefined && typeof data[k] !== 'boolean') {
                    return { command: 'update-settings', payload: { error: `Invalid value for ${k}` } };
                }
            }

            const notifUpdate: Record<string, boolean> = {};
            for (const k of NOTIF_KEYS) {
                if (data[k] !== undefined) {
                    notifUpdate[k] = data[k] as boolean;
                }
            }

            const updated = await db.settings.upsert({
                where: { userId: client.userId },
                update: {
                    ...(data.language !== undefined && { language: data.language }),
                    ...(data.theme !== undefined && { theme: data.theme }),
                    ...notifUpdate
                },
                create: {
                    userId: client.userId,
                    language: data.language ?? 'fr',
                    theme: data.theme ?? 'light',
                    ...notifUpdate
                }
            });

            logger.info(`[Settings] Updated settings for user: ${client.userId}`);
            return {
                command: 'update-settings',
                payload: {
                    settings: {
                        language: updated.language as Language,
                        theme: updated.theme as Theme,
                        notifNewMatch: updated.notifNewMatch,
                        notifLikes: updated.notifLikes,
                        notifMessages: updated.notifMessages,
                        notifNearbyPeople: updated.notifNearbyPeople,
                        notifActivityReminder24h: updated.notifActivityReminder24h,
                        notifActivityReminder1h: updated.notifActivityReminder1h
                    }
                }
            };
        } catch (error) {
            logger.error('[Settings] Update settings error', error);
            return { command: 'update-settings', payload: { error: 'Internal error' } };
        }
    }
);
