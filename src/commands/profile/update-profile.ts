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
import { logAudit } from '@/services/auditLogService';
import { isProfileComplete } from '@/services/profileCompletion';

class ProfileWouldBecomeIncompleteError extends Error {
    constructor() {
        super('profileWouldBecomeIncomplete');
        this.name = 'ProfileWouldBecomeIncompleteError';
    }
}

const TAG_MAX_LENGTH = 40;

/**
 * Sanitize a tag label:
 * - Strip invisible/control characters
 * - Collapse whitespace
 * - Trim
 * - Title-case first letter
 * - Max length
 */
function sanitizeTagLabel(raw: string): string {
    const s = raw
        .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202F\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, TAG_MAX_LENGTH);
    if (s.length === 0) return '';
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Resolve a sanitised user-submitted label to an existing canonical tag,
 * if any. Returns the tagId or null — we never create new canonical tags
 * at profile-save time. Promotion to a canonical tag happens in a separate
 * batch job once enough users converge on the same raw label.
 *
 *   1. Exact match on Tag.label
 *   2. Alias match on TagAlias.alias → canonical Tag
 *   3. null (the UserTag stays unlinked, scoring uses its raw label)
 */
async function resolveCanonical(db: ReturnType<typeof getDatabase>, label: string): Promise<string | null> {
    const exact = await db.tag.findUnique({ where: { label }, select: { id: true } });
    if (exact) return exact.id;

    const alias = await db.tagAlias.findFirst({
        where: { alias: { equals: label, mode: 'insensitive' } },
        select: { tagId: true }
    });
    if (alias) return alias.tagId;

    return null;
}

async function syncTags(
    db: ReturnType<typeof getDatabase>,
    userId: string,
    incoming: { label: string; source?: string | null }[],
    type: 'interest' | 'skill'
) {
    // Snapshot existing sources keyed by labelLower so we can preserve
    // provenance across saves that don't specify `source` (e.g. regular
    // profile edits).
    const previous = await db.userTag.findMany({
        where: { userId, type },
        select: { labelLower: true, source: true }
    });
    const previousSourceByLabelLower = new Map<string, string | null>();
    for (const row of previous) previousSourceByLabelLower.set(row.labelLower, row.source);

    await db.userTag.deleteMany({ where: { userId, type } });

    if (incoming.length === 0) return;

    const seen = new Set<string>();
    for (const raw of incoming) {
        const label = sanitizeTagLabel(raw.label);
        if (!label) continue;
        const labelLower = label.toLowerCase();
        if (seen.has(labelLower)) continue;
        seen.add(labelLower);

        const tagId = await resolveCanonical(db, label);

        // Preserve previous source when the client didn't include one.
        const source = raw.source !== undefined ? raw.source : (previousSourceByLabelLower.get(labelLower) ?? null);

        await db.userTag.create({
            data: { userId, type, label, labelLower, tagId, source }
        });
    }
}

registerCommand<WSRequest_UpdateProfile>(
    'update-profile',
    async (client: Client, payload): Promise<WSResponse_UpdateProfile> => {
        const { data } = payload;
        const db = getDatabase();

        // ─── Input validation ─────────────────────────────────────────────────
        const validationError = validateProfileData(data as Record<string, unknown>);
        if (validationError) {
            return { command: 'update-profile', payload: { error: validationError } };
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
                if (data.intentions !== undefined) profileData.intentions = data.intentions;
                if (data.spokenLanguages !== undefined) profileData.spokenLanguages = data.spokenLanguages;

                if (Object.keys(profileData).length > 0) {
                    await tx.profile.update({
                        where: { userId: client.userId },
                        data: profileData
                    });
                }

                // Sync interests
                if (data.interests !== undefined) {
                    await syncTags(
                        tx as ReturnType<typeof getDatabase>,
                        client.userId,
                        data.interests.map((t) => ({ label: t.label, source: t.source })),
                        'interest'
                    );
                }

                // Sync skills
                if (data.skills !== undefined) {
                    await syncTags(
                        tx as ReturnType<typeof getDatabase>,
                        client.userId,
                        data.skills.map((t) => ({ label: t.label, source: t.source })),
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

            logger.info(`[Profile] Updated profile for user: ${client.userId}`);

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

            // Invalidate caches so discovery reflects updated profile immediately
            invalidateCandidate(client.userId).catch(() => {});
            invalidatePipelineSetup(client.userId).catch(() => {});
            invalidateDiscoveryCounts(client.userId).catch(() => {});

            // Re-fetch and return updated profile
            const updated = await db.user.findUnique({
                where: { id: client.userId },
                include: profileInclude
            });

            if (!updated) {
                return { command: 'update-profile', payload: { error: 'User not found' } };
            }

            return { command: 'update-profile', payload: { user: mapUserToProfile(updated) } };
        } catch (error) {
            if (error instanceof ProfileWouldBecomeIncompleteError) {
                return { command: 'update-profile', payload: { error: 'profileWouldBecomeIncomplete' } };
            }
            logger.error('[Profile] Update profile error', error);
            return { command: 'update-profile', payload: { error: 'Internal error' } };
        }
    }
);
