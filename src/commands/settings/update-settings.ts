import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_UpdateSettings, WSResponse_UpdateSettings, Language, Theme } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

const VALID_LANGUAGES: Language[] = ['fr', 'en'];
const VALID_THEMES: Theme[] = ['light', 'dark'];

registerCommand<WSRequest_UpdateSettings>(
    'update-settings',
    async (client: Client, payload): Promise<WSResponse_UpdateSettings> => {
        const { data } = payload;
        const db = getDatabase();

        try {
            if (data.language === undefined && data.theme === undefined) {
                return { command: 'update-settings', payload: { error: 'No settings provided' } };
            }

            if (data.language !== undefined && !VALID_LANGUAGES.includes(data.language)) {
                return { command: 'update-settings', payload: { error: 'Invalid language' } };
            }

            if (data.theme !== undefined && !VALID_THEMES.includes(data.theme)) {
                return { command: 'update-settings', payload: { error: 'Invalid theme' } };
            }

            const updated = await db.settings.upsert({
                where: { userId: client.userId },
                update: {
                    ...(data.language !== undefined && { language: data.language }),
                    ...(data.theme !== undefined && { theme: data.theme })
                },
                create: {
                    userId: client.userId,
                    language: data.language ?? 'fr',
                    theme: data.theme ?? 'light'
                }
            });

            logger.info(`[Settings] Updated settings for user: ${client.userId}`);
            return {
                command: 'update-settings',
                payload: {
                    settings: {
                        language: updated.language as Language,
                        theme: updated.theme as Theme
                    }
                }
            };
        } catch (error) {
            logger.error('[Settings] Update settings error', error);
            return { command: 'update-settings', payload: { error: 'Internal error' } };
        }
    }
);
