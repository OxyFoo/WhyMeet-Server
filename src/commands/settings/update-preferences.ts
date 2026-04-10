import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type {
    WSRequest_UpdatePreferences,
    WSResponse_UpdatePreferences,
    DiscoveryPreferences,
    VisibilityPreferences,
    Gender,
    IntentionKey
} from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

const VALID_GENDERS = new Set<string>(['male', 'female', 'non_binary']);

function validateGenders(arr: unknown): arr is Gender[] {
    return Array.isArray(arr) && arr.every((g) => typeof g === 'string' && VALID_GENDERS.has(g));
}

function validateAgeRange(arr: unknown): arr is [number, number] {
    if (!Array.isArray(arr) || arr.length !== 2) return false;
    const [min, max] = arr;
    return typeof min === 'number' && typeof max === 'number' && min >= 18 && max <= 99 && min <= max;
}

registerCommand<WSRequest_UpdatePreferences>(
    'update-preferences',
    async (client: Client, payload): Promise<WSResponse_UpdatePreferences> => {
        const db = getDatabase();
        const { discovery, visibility, syncVisibility } = payload;

        try {
            if (discovery === undefined && visibility === undefined && syncVisibility === undefined) {
                return { command: 'update-preferences', payload: { error: 'No preferences provided' } };
            }

            // Validate discovery fields
            if (discovery) {
                if (discovery.ageRange !== undefined && !validateAgeRange(discovery.ageRange)) {
                    return { command: 'update-preferences', payload: { error: 'Invalid age range' } };
                }
                if (discovery.genders !== undefined && !validateGenders(discovery.genders)) {
                    return { command: 'update-preferences', payload: { error: 'Invalid genders' } };
                }
                if (
                    discovery.maxDistance !== undefined &&
                    (typeof discovery.maxDistance !== 'number' ||
                        discovery.maxDistance < 1 ||
                        discovery.maxDistance > 500)
                ) {
                    return { command: 'update-preferences', payload: { error: 'Invalid max distance' } };
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
                if (
                    visibility.maxDistance !== undefined &&
                    (typeof visibility.maxDistance !== 'number' ||
                        visibility.maxDistance < 1 ||
                        visibility.maxDistance > 500)
                ) {
                    return { command: 'update-preferences', payload: { error: 'Invalid max distance' } };
                }
            }

            // Build update data
            const data: Record<string, unknown> = {};

            if (discovery) {
                if (discovery.ageRange !== undefined) {
                    data.discoveryAgeMin = discovery.ageRange[0];
                    data.discoveryAgeMax = discovery.ageRange[1];
                }
                if (discovery.genders !== undefined) data.discoveryGenders = discovery.genders;
                if (discovery.intentions !== undefined) data.discoveryIntentions = discovery.intentions;
                if (discovery.maxDistance !== undefined) data.discoveryMaxDistance = discovery.maxDistance;
                if (discovery.remoteMode !== undefined) data.discoveryRemoteMode = discovery.remoteMode;
                if (discovery.verifiedOnly !== undefined) data.discoveryVerified = discovery.verifiedOnly;
                if (discovery.photosOnly !== undefined) data.discoveryPhotosOnly = discovery.photosOnly;
            }

            if (syncVisibility !== undefined) {
                data.syncVisibility = syncVisibility;
            }

            // If syncVisibility is on (or becoming on), copy discovery values to visibility
            const shouldSync =
                syncVisibility === true ||
                (syncVisibility === undefined &&
                    (await db.settings.findUnique({ where: { userId: client.userId } }))?.syncVisibility);

            if (shouldSync && discovery) {
                if (discovery.ageRange !== undefined) {
                    data.visibilityAgeMin = discovery.ageRange[0];
                    data.visibilityAgeMax = discovery.ageRange[1];
                }
                if (discovery.genders !== undefined) data.visibilityGenders = discovery.genders;
                if (discovery.intentions !== undefined) data.visibilityIntentions = discovery.intentions;
                if (discovery.maxDistance !== undefined) data.visibilityMaxDistance = discovery.maxDistance;
                if (discovery.remoteMode !== undefined) data.visibilityRemoteMode = discovery.remoteMode;
            } else if (visibility && !shouldSync) {
                if (visibility.ageRange !== undefined) {
                    data.visibilityAgeMin = visibility.ageRange[0];
                    data.visibilityAgeMax = visibility.ageRange[1];
                }
                if (visibility.genders !== undefined) data.visibilityGenders = visibility.genders;
                if (visibility.intentions !== undefined) data.visibilityIntentions = visibility.intentions;
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

            const resDiscovery: DiscoveryPreferences = {
                ageRange: [updated.discoveryAgeMin, updated.discoveryAgeMax],
                genders: updated.discoveryGenders as Gender[],
                intentions: updated.discoveryIntentions as IntentionKey[],
                maxDistance: updated.discoveryMaxDistance,
                remoteMode: updated.discoveryRemoteMode,
                verifiedOnly: updated.discoveryVerified,
                photosOnly: updated.discoveryPhotosOnly
            };

            const resVisibility: VisibilityPreferences = {
                ageRange: [updated.visibilityAgeMin, updated.visibilityAgeMax],
                genders: updated.visibilityGenders as Gender[],
                intentions: updated.visibilityIntentions as IntentionKey[],
                maxDistance: updated.visibilityMaxDistance,
                remoteMode: updated.visibilityRemoteMode
            };

            logger.info(`[Settings] Updated preferences for user: ${client.userId}`);
            return {
                command: 'update-preferences',
                payload: {
                    discovery: resDiscovery,
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
