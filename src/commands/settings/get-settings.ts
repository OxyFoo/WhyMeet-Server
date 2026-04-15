import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetSettings, WSResponse_GetSettings, Language, Theme } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetSettings>('get-settings', async (client: Client): Promise<WSResponse_GetSettings> => {
    const db = getDatabase();

    try {
        const settings = await db.settings.findUnique({
            where: { userId: client.userId }
        });

        return {
            command: 'get-settings',
            payload: {
                settings: {
                    language: (settings?.language ?? 'fr') as Language,
                    theme: (settings?.theme ?? 'light') as Theme,
                    notifNewMatch: settings?.notifNewMatch ?? true,
                    notifLikes: settings?.notifLikes ?? true,
                    notifMessages: settings?.notifMessages ?? true,
                    notifNearbyPeople: settings?.notifNearbyPeople ?? true,
                    notifActivityReminders: settings?.notifActivityReminders ?? false
                }
            }
        };
    } catch (error) {
        logger.error('[Settings] Get settings error', error);
        return { command: 'get-settings', payload: { error: 'Internal error' } };
    }
});
