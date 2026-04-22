import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type {
    WSRequest_GetPreferences,
    WSResponse_GetPreferences,
    PeoplePreferences,
    ActivityPreferences,
    VisibilityPreferences,
    Gender
} from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { DEFAULT_PEOPLE, DEFAULT_ACTIVITY, DEFAULT_VISIBILITY } from '@oxyfoo/whymeet-types';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetPreferences>(
    'get-preferences',
    async (client: Client): Promise<WSResponse_GetPreferences> => {
        const db = getDatabase();

        try {
            const settings = await db.settings.findUnique({
                where: { userId: client.userId }
            });

            const people: PeoplePreferences = {
                ageRange: [
                    settings?.peopleAgeMin ?? DEFAULT_PEOPLE.ageRange[0],
                    settings?.peopleAgeMax ?? DEFAULT_PEOPLE.ageRange[1]
                ],
                genders: (settings?.peopleGenders ?? DEFAULT_PEOPLE.genders) as Gender[],
                maxDistance: settings?.peopleMaxDistance ?? DEFAULT_PEOPLE.maxDistance,
                remoteMode: settings?.peopleRemoteMode ?? DEFAULT_PEOPLE.remoteMode,
                verifiedOnly: settings?.peopleVerified ?? DEFAULT_PEOPLE.verifiedOnly,
                photosOnly: settings?.peoplePhotosOnly ?? DEFAULT_PEOPLE.photosOnly,
                languages: settings?.peopleLanguages ?? DEFAULT_PEOPLE.languages
            };

            const activity: ActivityPreferences = {
                genders: (settings?.activityGenders ?? DEFAULT_ACTIVITY.genders) as Gender[],
                maxDistance: settings?.activityMaxDistance ?? DEFAULT_ACTIVITY.maxDistance,
                remoteMode: settings?.activityRemoteMode ?? DEFAULT_ACTIVITY.remoteMode,
                verifiedOnly: settings?.activityVerified ?? DEFAULT_ACTIVITY.verifiedOnly,
                languages: settings?.activityLanguages ?? DEFAULT_ACTIVITY.languages
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
                    people,
                    activity,
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
