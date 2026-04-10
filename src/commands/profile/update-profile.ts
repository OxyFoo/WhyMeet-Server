import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_UpdateProfile, WSResponse_UpdateProfile } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { mapUserToProfile, profileInclude } from '@/services/userMapper';
import { ensureTagEmbedding } from '@/services/embedding';
import { logger } from '@/config/logger';

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

        try {
            await db.$transaction(async (tx) => {
                // Update user base fields
                await tx.user.update({
                    where: { id: client.userId },
                    data: {
                        ...(data.name !== undefined && { name: data.name }),
                        ...(data.age !== undefined && { age: data.age }),
                        ...(data.avatar !== undefined && { avatar: data.avatar }),
                        ...(data.city !== undefined && { city: data.city })
                    }
                });

                // Update profile fields (bio, socialVibe, location, intentions)
                const profileData: Record<string, unknown> = {};
                if (data.bio !== undefined) profileData.bio = data.bio;
                if (data.socialVibe !== undefined) profileData.socialVibe = data.socialVibe;
                if (data.location?.country !== undefined) profileData.country = data.location.country;
                if (data.location?.region !== undefined) profileData.region = data.location.region;
                if (data.location?.city !== undefined) profileData.city = data.location.city;
                if (data.location?.latitude !== undefined) profileData.latitude = data.location.latitude;
                if (data.location?.longitude !== undefined) profileData.longitude = data.location.longitude;
                if (data.intentions !== undefined) profileData.intentions = data.intentions;

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
