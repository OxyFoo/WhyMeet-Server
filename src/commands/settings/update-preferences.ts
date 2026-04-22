import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type {
    WSRequest_UpdatePreferences,
    WSResponse_UpdatePreferences,
    PeoplePreferences,
    ActivityPreferences,
    VisibilityPreferences,
    Gender
} from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { GENDERS } from '@oxyfoo/whymeet-types';
import { invalidatePipelineSetup } from '@/services/pipelineSetupCache';
import { logger } from '@/config/logger';

const VALID_GENDERS = new Set<string>(GENDERS);

function validateGenders(arr: unknown): arr is Gender[] {
    return Array.isArray(arr) && arr.every((g) => typeof g === 'string' && VALID_GENDERS.has(g));
}

function validateAgeRange(arr: unknown): arr is [number, number] {
    if (!Array.isArray(arr) || arr.length !== 2) return false;
    const [min, max] = arr;
    return typeof min === 'number' && typeof max === 'number' && min >= 18 && max <= 99 && min <= max;
}

function validateLanguages(arr: unknown): arr is string[] {
    return Array.isArray(arr) && arr.every((l) => typeof l === 'string' && l.length >= 2 && l.length <= 10);
}

function validateMaxDistance(n: unknown): boolean {
    return typeof n === 'number' && n >= 1 && n <= 500;
}

registerCommand<WSRequest_UpdatePreferences>(
    'update-preferences',
    async (client: Client, payload): Promise<WSResponse_UpdatePreferences> => {
        const db = getDatabase();
        const { people, activity, visibility, syncVisibility } = payload;

        try {
            if (
                people === undefined &&
                activity === undefined &&
                visibility === undefined &&
                syncVisibility === undefined
            ) {
                return { command: 'update-preferences', payload: { error: 'No preferences provided' } };
            }

            // Validate people fields
            if (people) {
                if (people.ageRange !== undefined && !validateAgeRange(people.ageRange)) {
                    return { command: 'update-preferences', payload: { error: 'Invalid age range' } };
                }
                if (people.genders !== undefined && !validateGenders(people.genders)) {
                    return { command: 'update-preferences', payload: { error: 'Invalid genders' } };
                }
                if (people.maxDistance !== undefined && !validateMaxDistance(people.maxDistance)) {
                    return { command: 'update-preferences', payload: { error: 'Invalid max distance' } };
                }
                if (people.languages !== undefined && !validateLanguages(people.languages)) {
                    return { command: 'update-preferences', payload: { error: 'Invalid languages' } };
                }
            }

            // Validate activity fields
            if (activity) {
                if (activity.genders !== undefined && !validateGenders(activity.genders)) {
                    return { command: 'update-preferences', payload: { error: 'Invalid genders' } };
                }
                if (activity.maxDistance !== undefined && !validateMaxDistance(activity.maxDistance)) {
                    return { command: 'update-preferences', payload: { error: 'Invalid max distance' } };
                }
                if (activity.languages !== undefined && !validateLanguages(activity.languages)) {
                    return { command: 'update-preferences', payload: { error: 'Invalid languages' } };
                }
            }

            // Validate visibility fields
            if (visibility) {
                if (visibility.ageRange !== undefined && !validateAgeRange(visibility.ageRange)) {
                    return { command: 'update-preferences', payload: { error: 'Invalid age range' } };
                }
                if (visibility.genders !== undefined && !validateGenders(visibility.genders)) {
                    return { command: 'update-preferences', payload: { error: 'Invalid genders' } };
                }
                if (visibility.maxDistance !== undefined && !validateMaxDistance(visibility.maxDistance)) {
                    return { command: 'update-preferences', payload: { error: 'Invalid max distance' } };
                }
            }

            // Build update data
            const data: Record<string, unknown> = {};

            if (people) {
                if (people.ageRange !== undefined) {
                    data.peopleAgeMin = people.ageRange[0];
                    data.peopleAgeMax = people.ageRange[1];
                }
                if (people.genders !== undefined) data.peopleGenders = people.genders;
                if (people.maxDistance !== undefined) data.peopleMaxDistance = people.maxDistance;
                if (people.remoteMode !== undefined) data.peopleRemoteMode = people.remoteMode;
                if (people.verifiedOnly !== undefined) data.peopleVerified = people.verifiedOnly;
                if (people.photosOnly !== undefined) data.peoplePhotosOnly = people.photosOnly;
                if (people.languages !== undefined) data.peopleLanguages = people.languages;
            }

            if (activity) {
                if (activity.genders !== undefined) data.activityGenders = activity.genders;
                if (activity.maxDistance !== undefined) data.activityMaxDistance = activity.maxDistance;
                if (activity.remoteMode !== undefined) data.activityRemoteMode = activity.remoteMode;
                if (activity.verifiedOnly !== undefined) data.activityVerified = activity.verifiedOnly;
                if (activity.languages !== undefined) data.activityLanguages = activity.languages;
            }

            if (syncVisibility !== undefined) {
                data.syncVisibility = syncVisibility;
            }

            // If syncVisibility is on (or becoming on), copy people values to visibility
            const shouldSync =
                syncVisibility === true ||
                (syncVisibility === undefined &&
                    (await db.settings.findUnique({ where: { userId: client.userId } }))?.syncVisibility);

            if (shouldSync && people) {
                if (people.ageRange !== undefined) {
                    data.visibilityAgeMin = people.ageRange[0];
                    data.visibilityAgeMax = people.ageRange[1];
                }
                if (people.genders !== undefined) data.visibilityGenders = people.genders;
                if (people.maxDistance !== undefined) data.visibilityMaxDistance = people.maxDistance;
                if (people.remoteMode !== undefined) data.visibilityRemoteMode = people.remoteMode;
            } else if (visibility && !shouldSync) {
                if (visibility.ageRange !== undefined) {
                    data.visibilityAgeMin = visibility.ageRange[0];
                    data.visibilityAgeMax = visibility.ageRange[1];
                }
                if (visibility.genders !== undefined) data.visibilityGenders = visibility.genders;
                if (visibility.maxDistance !== undefined) data.visibilityMaxDistance = visibility.maxDistance;
                if (visibility.remoteMode !== undefined) data.visibilityRemoteMode = visibility.remoteMode;
            }

            const updated = await db.settings.upsert({
                where: { userId: client.userId },
                update: data,
                create: {
                    userId: client.userId,
                    ...data
                }
            });

            const resPeople: PeoplePreferences = {
                ageRange: [updated.peopleAgeMin, updated.peopleAgeMax],
                genders: updated.peopleGenders as Gender[],
                maxDistance: updated.peopleMaxDistance,
                remoteMode: updated.peopleRemoteMode,
                verifiedOnly: updated.peopleVerified,
                photosOnly: updated.peoplePhotosOnly,
                languages: updated.peopleLanguages
            };

            const resActivity: ActivityPreferences = {
                genders: updated.activityGenders as Gender[],
                maxDistance: updated.activityMaxDistance,
                remoteMode: updated.activityRemoteMode,
                verifiedOnly: updated.activityVerified,
                languages: updated.activityLanguages
            };

            const resVisibility: VisibilityPreferences = {
                ageRange: [updated.visibilityAgeMin, updated.visibilityAgeMax],
                genders: updated.visibilityGenders as Gender[],
                maxDistance: updated.visibilityMaxDistance,
                remoteMode: updated.visibilityRemoteMode
            };

            logger.info(`[Settings] Updated preferences for user: ${client.userId}`);
            invalidatePipelineSetup(client.userId).catch(() => {});
            return {
                command: 'update-preferences',
                payload: {
                    people: resPeople,
                    activity: resActivity,
                    visibility: resVisibility,
                    syncVisibility: updated.syncVisibility
                }
            };
        } catch (error) {
            logger.error('[Settings] Update preferences error', error);
            return { command: 'update-preferences', payload: { error: 'Internal error' } };
        }
    }
);
