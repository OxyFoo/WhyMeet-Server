import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_UpdateProfile, WSResponse_UpdateProfile } from '@oxyfoo/whymeet-types';
import { GENDERS, PREFERRED_PERIODS } from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { mapUserToProfile, profileInclude, computeAge } from '@/services/userMapper';
import { ensureTagEmbedding } from '@/services/embedding';
import { discretizePosition } from '@/services/geoUtils';
import { logger } from '@/config/logger';
import { validateProfileData } from '@/config/validation';
import { invalidateCandidate } from '@/services/candidateCache';
import { invalidatePipelineSetup } from '@/services/pipelineSetupCache';
import { logAudit } from '@/services/auditLogService';

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
 * Resolve a user-submitted label to a canonical tag.
 * 1. Exact match on Tag.label
 * 2. Alias match on TagAlias.alias → canonical Tag
 * 3. Create new tag + generate embedding
 */
async function resolveTag(db: ReturnType<typeof getDatabase>, label: string): Promise<{ id: string; label: string }> {
    // 1. Exact match
    const exact = await db.tag.findUnique({ where: { label } });
    if (exact) return { id: exact.id, label: exact.label };

    // 2. Alias match (case-insensitive)
    const alias = await db.tagAlias.findFirst({
        where: { alias: { equals: label, mode: 'insensitive' } },
        include: { tag: { select: { id: true, label: true } } }
    });
    if (alias) return { id: alias.tag.id, label: alias.tag.label };

    // 3. Create new tag + embedding
    const newTag = await db.tag.create({ data: { label } });
    // Fire-and-forget embedding generation (non-blocking)
    ensureTagEmbedding(newTag.id, label).catch(() => {});
    return { id: newTag.id, label: newTag.label };
}

async function syncTags(
    db: ReturnType<typeof getDatabase>,
    userId: string,
    labels: string[],
    type: 'interest' | 'skill'
) {
    // Delete existing tags of this type
    await db.userTag.deleteMany({ where: { userId, type } });

    if (labels.length === 0) return;

    // Resolve each label to a canonical tag, then create UserTag links
    const resolved = new Set<string>();
    for (const raw of labels) {
        const label = sanitizeTagLabel(raw);
        if (!label) continue;
        const tag = await resolveTag(db, label);
        // Avoid duplicates (different labels resolving to same canonical tag)
        if (resolved.has(tag.id)) continue;
        resolved.add(tag.id);
        await db.userTag.create({
            data: { userId, tagId: tag.id, type }
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
                        data.interests.map((t) => t.label),
                        'interest'
                    );
                }

                // Sync skills
                if (data.skills !== undefined) {
                    await syncTags(
                        tx as ReturnType<typeof getDatabase>,
                        client.userId,
                        data.skills.map((t) => t.label),
                        'skill'
                    );
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
                    client.ip
                );
            }

            // Invalidate caches so discovery reflects updated profile immediately
            invalidateCandidate(client.userId).catch(() => {});
            invalidatePipelineSetup(client.userId).catch(() => {});

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
            logger.error('[Profile] Update profile error', error);
            return { command: 'update-profile', payload: { error: 'Internal error' } };
        }
    }
);
