import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_UpdateProfile, WSResponse_UpdateProfile } from '@oxyfoo/whymeet-types';
import { GENDERS, PREFERRED_PERIODS } from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { mapUserToProfile, profileInclude, computeAge } from '@/services/userMapper';
import { discretizePosition } from '@/services/geoUtils';
import { logger } from '@/config/logger';
import { validateProfileData } from '@/config/validation';
import { invalidateCandidate } from '@/services/candidateCache';
import { invalidatePipelineSetup } from '@/services/pipelineSetupCache';
import { invalidateDiscoveryCounts } from '@/services/discoveryCountsCache';
import { invalidateActivityCatalogCache, invalidateActivityDiscoveryCache } from '@/services/activityDiscoveryService';
import { logAudit } from '@/services/auditLogService';
import { isProfileComplete } from '@/services/profileCompletion';
import { prepareUserTagSync, replaceUserTags } from '@/services/userTagSync';
import { expandSelectedIntentionKeys } from '@/services/intentionProfileEnrichment';
import { normalizeActiveIntentionKeys } from '@/services/intentionKeys';

class ProfileWouldBecomeIncompleteError extends Error {
    constructor() {
        super('profileWouldBecomeIncomplete');
        this.name = 'ProfileWouldBecomeIncompleteError';
    }
}

registerCommand<WSRequest_UpdateProfile>(
    'update-profile',
    async (client: Client, payload): Promise<WSResponse_UpdateProfile> => {
        const { data } = payload;
        const db = getDatabase();
        const updatedFields = Object.keys(data);

        // ─── Input validation ─────────────────────────────────────────────────
        const validationError = validateProfileData(data as Record<string, unknown>);
        if (validationError) {
            logger.warn(`[Profile] Validation failed for user ${client.userId}`, {
                updatedFields,
                validationError
            });
            return { command: 'update-profile', payload: { error: validationError } };
        }

        const submittedIntentionKeys = Array.isArray(data.intentionKeys)
            ? data.intentionKeys.filter((key) => typeof key === 'string')
            : undefined;
        const normalizedIntentionKeys = normalizeActiveIntentionKeys(submittedIntentionKeys);
        const normalizedIntentionKeySet = new Set(normalizedIntentionKeys);
        const droppedIntentionKeys = Array.from(
            new Set((submittedIntentionKeys ?? []).filter((key) => !normalizedIntentionKeySet.has(key)))
        );

        if (droppedIntentionKeys.length > 0) {
            logger.warn(`[Profile] Dropped unknown intention keys for user ${client.userId}`, {
                updatedFields,
                droppedIntentionKeys
            });
        }
        // ─────────────────────────────────────────────────────────────────────

        try {
            // ─── Rate-limit check: birthDate can only change once per year ────────
            let previousBirthDate: Date | null = null;
            let newParsedBirthDate: Date | null = null;
            if (data.birthDate !== undefined && data.birthDate !== null) {
                const currentUser = await db.user.findUnique({
                    where: { id: client.userId },
                    select: { birthDate: true, birthDateLastChangedAt: true }
                });
                previousBirthDate = currentUser?.birthDate ?? null;
                const incomingBirthDate = new Date(data.birthDate);
                const isSameDate =
                    previousBirthDate !== null &&
                    !isNaN(incomingBirthDate.getTime()) &&
                    previousBirthDate.getTime() === incomingBirthDate.getTime();
                // Only rate-limit actual changes, not no-op saves that resend the same date.
                if (previousBirthDate && !isSameDate && currentUser?.birthDateLastChangedAt) {
                    const msPerYear = 365 * 24 * 60 * 60 * 1000;
                    if (Date.now() - currentUser.birthDateLastChangedAt.getTime() < msPerYear) {
                        logger.warn(`[Profile] Birth date change rate limited for user ${client.userId}`, {
                            updatedFields
                        });
                        return { command: 'update-profile', payload: { error: 'birthDateChangeRateLimited' } };
                    }
                }
            }
            // ─────────────────────────────────────────────────────────────────────

            // Snapshot completion state before mutating, so we can refuse a
            // change that would regress a fully-completed profile.
            const beforeUser = await db.user.findUnique({
                where: { id: client.userId },
                include: profileInclude
            });
            const wasComplete = beforeUser ? isProfileComplete(beforeUser) : false;

            const preparedInterestRows =
                data.interests !== undefined
                    ? await prepareUserTagSync(
                          db,
                          client.userId,
                          data.interests.map((tag) => ({ label: tag.label, source: tag.source })),
                          'interest'
                      )
                    : null;
            const preparedSkillRows =
                data.skills !== undefined
                    ? await prepareUserTagSync(
                          db,
                          client.userId,
                          data.skills.map((tag) => ({ label: tag.label, source: tag.source })),
                          'skill'
                      )
                    : null;

            await db.$transaction(async (tx) => {
                // Update user base fields
                const userData: Record<string, unknown> = {};
                if (data.name !== undefined) userData.name = (data.name as string).trim();
                if (data.birthDate !== undefined) {
                    if (data.birthDate === null) {
                        userData.birthDate = null;
                    } else {
                        const parsed = new Date(data.birthDate);
                        if (!isNaN(parsed.getTime()) && computeAge(parsed) >= 18) {
                            userData.birthDate = parsed;
                            // Only count as "modification" when a previous birthDate existed
                            // AND the new date is actually different. The first definition and
                            // no-op saves must not consume the yearly quota.
                            const isActualChange =
                                previousBirthDate !== null && previousBirthDate.getTime() !== parsed.getTime();
                            if (isActualChange) {
                                userData.birthDateLastChangedAt = new Date();
                                newParsedBirthDate = parsed;
                            }
                        }
                    }
                }
                if (data.gender !== undefined && (GENDERS as readonly string[]).includes(data.gender)) {
                    userData.gender = data.gender;
                }
                if (
                    data.preferredPeriod !== undefined &&
                    (PREFERRED_PERIODS as readonly string[]).includes(data.preferredPeriod)
                ) {
                    userData.preferredPeriod = data.preferredPeriod;
                }
                if (data.city !== undefined) userData.city = data.city;

                await tx.user.update({
                    where: { id: client.userId },
                    data: userData
                });

                // Update profile fields (bio, socialVibe, location, intentions)
                const profileData: Record<string, unknown> = {};
                if (data.bio !== undefined) profileData.bio = data.bio;
                if (data.socialVibe !== undefined) profileData.socialVibe = data.socialVibe;
                if (data.location?.country !== undefined) profileData.country = data.location.country;
                if (data.location?.region !== undefined) profileData.region = data.location.region;
                if (data.location?.city !== undefined) profileData.city = data.location.city;
                if (!!data.location?.latitude && !!data.location?.longitude) {
                    const discretized = discretizePosition(data.location.latitude, data.location.longitude);
                    profileData.latitude = discretized.latitude;
                    profileData.longitude = discretized.longitude;
                }
                if (data.intentionKeys !== undefined) {
                    profileData.intentionKeys = expandSelectedIntentionKeys(normalizedIntentionKeys);
                }
                if (data.spokenLanguages !== undefined) profileData.spokenLanguages = data.spokenLanguages;

                if (Object.keys(profileData).length > 0) {
                    await tx.profile.update({
                        where: { userId: client.userId },
                        data: profileData
                    });
                }

                // Sync interests
                if (preparedInterestRows) {
                    await replaceUserTags(
                        tx as ReturnType<typeof getDatabase>,
                        client.userId,
                        preparedInterestRows,
                        'interest'
                    );
                }

                // Sync skills
                if (preparedSkillRows) {
                    await replaceUserTags(
                        tx as ReturnType<typeof getDatabase>,
                        client.userId,
                        preparedSkillRows,
                        'skill'
                    );
                }

                // Refuse to persist a regression from complete → incomplete.
                if (wasComplete) {
                    const after = await tx.user.findUnique({
                        where: { id: client.userId },
                        include: profileInclude
                    });
                    if (!after || !isProfileComplete(after)) {
                        throw new ProfileWouldBecomeIncompleteError();
                    }
                }
            });

            logger.info(`[Profile] Updated profile for user: ${client.userId}`, { updatedFields });

            // Audit log for birthDate change
            // TypeScript doesn't track let mutations inside async callbacks — cast is safe here
            const capturedNewBirthDate = newParsedBirthDate as Date | null;
            if (capturedNewBirthDate !== null) {
                logAudit(
                    client.userId,
                    'BIRTH_DATE_CHANGED',
                    { oldDate: previousBirthDate?.toISOString() ?? null, newDate: capturedNewBirthDate.toISOString() },
                    { ip: client.ip }
                );
            }

            const affectsHostedActivityDiscovery =
                data.gender !== undefined ||
                data.interests !== undefined ||
                data.spokenLanguages !== undefined ||
                data.intentionKeys !== undefined;

            await Promise.allSettled([
                invalidateCandidate(client.userId),
                invalidatePipelineSetup(client.userId),
                invalidateDiscoveryCounts(client.userId),
                invalidateActivityDiscoveryCache(client.userId),
                ...(affectsHostedActivityDiscovery ? [invalidateActivityCatalogCache()] : [])
            ]);

            // Re-fetch and return updated profile
            const updated = await db.user.findUnique({
                where: { id: client.userId },
                include: profileInclude
            });

            if (!updated) {
                logger.error(`[Profile] User not found after update for user ${client.userId}`, {
                    updatedFields
                });
                return { command: 'update-profile', payload: { error: 'User not found' } };
            }

            return { command: 'update-profile', payload: { user: mapUserToProfile(updated) } };
        } catch (error) {
            if (error instanceof ProfileWouldBecomeIncompleteError) {
                logger.warn(`[Profile] Rejected update that would make profile incomplete for user ${client.userId}`, {
                    updatedFields
                });
                return { command: 'update-profile', payload: { error: 'profileWouldBecomeIncomplete' } };
            }
            logger.error(`[Profile] Update profile error for user ${client.userId}`, { updatedFields }, error);
            return { command: 'update-profile', payload: { error: 'Internal error' } };
        }
    }
);
