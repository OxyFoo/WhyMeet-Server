import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type {
    WSRequest_GetPreferences,
    WSResponse_GetPreferences,
    DiscoveryPreferences,
    VisibilityPreferences,
    Gender
} from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetPreferences>(
    'get-preferences',
    async (client: Client): Promise<WSResponse_GetPreferences> => {
        const db = getDatabase();

        try {
            const settings = await db.settings.findUnique({
                where: { userId: client.userId }
            });

            const discovery: DiscoveryPreferences = {
                ageRange: [settings?.discoveryAgeMin ?? 18, settings?.discoveryAgeMax ?? 99],
                genders: (settings?.discoveryGenders ?? ['male', 'female', 'non_binary']) as Gender[],
                maxDistance: settings?.discoveryMaxDistance ?? 50,
                remoteMode: settings?.discoveryRemoteMode ?? false,
                verifiedOnly: settings?.discoveryVerified ?? false,
                photosOnly: settings?.discoveryPhotosOnly ?? false
            };

            const visibility: VisibilityPreferences = {
                ageRange: [settings?.visibilityAgeMin ?? 18, settings?.visibilityAgeMax ?? 99],
                genders: (settings?.visibilityGenders ?? ['male', 'female', 'non_binary']) as Gender[],
                maxDistance: settings?.visibilityMaxDistance ?? 50,
                remoteMode: settings?.visibilityRemoteMode ?? false
            };

            return {
                command: 'get-preferences',
                payload: {
                    discovery,
                    visibility,
                    syncVisibility: settings?.syncVisibility ?? true
                }
            };
        } catch (error) {
            logger.error('[Settings] Get preferences error', error);
            return { command: 'get-preferences', payload: { error: 'Internal error' } };
        }
    }
);
