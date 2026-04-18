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
import { DEFAULT_DISCOVERY, DEFAULT_VISIBILITY } from '@oxyfoo/whymeet-types';
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
                ageRange: [
                    settings?.discoveryAgeMin ?? DEFAULT_DISCOVERY.ageRange[0],
                    settings?.discoveryAgeMax ?? DEFAULT_DISCOVERY.ageRange[1]
                ],
                genders: (settings?.discoveryGenders ?? DEFAULT_DISCOVERY.genders) as Gender[],
                maxDistance: settings?.discoveryMaxDistance ?? DEFAULT_DISCOVERY.maxDistance,
                remoteMode: settings?.discoveryRemoteMode ?? DEFAULT_DISCOVERY.remoteMode,
                verifiedOnly: settings?.discoveryVerified ?? DEFAULT_DISCOVERY.verifiedOnly,
                photosOnly: settings?.discoveryPhotosOnly ?? DEFAULT_DISCOVERY.photosOnly
            };

            const visibility: VisibilityPreferences = {
                ageRange: [
                    settings?.visibilityAgeMin ?? DEFAULT_VISIBILITY.ageRange[0],
                    settings?.visibilityAgeMax ?? DEFAULT_VISIBILITY.ageRange[1]
                ],
                genders: (settings?.visibilityGenders ?? DEFAULT_VISIBILITY.genders) as Gender[],
                maxDistance: settings?.visibilityMaxDistance ?? DEFAULT_VISIBILITY.maxDistance,
                remoteMode: settings?.visibilityRemoteMode ?? DEFAULT_VISIBILITY.remoteMode
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
