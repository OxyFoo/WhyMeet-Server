import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_UpdateProfile, WSResponse_UpdateProfile } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { mapUserToProfile, profileInclude } from '@/services/userMapper';
import { logger } from '@/config/logger';

async function syncTags(
    db: ReturnType<typeof getDatabase>,
    userId: string,
    labels: string[],
    type: 'interest' | 'skill'
) {
    // Delete existing tags of this type
    await db.userTag.deleteMany({ where: { userId, type } });

    if (labels.length === 0) return;

    // Find-or-create each tag, then create UserTag links
    for (const label of labels) {
        const tag = await db.tag.upsert({
            where: { label },
            update: {},
            create: { label }
        });
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
