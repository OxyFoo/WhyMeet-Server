import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_UpdateProfile, WSResponse_UpdateProfile } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_UpdateProfile>(
    'update-profile',
    async (client: Client, payload): Promise<WSResponse_UpdateProfile> => {
        const { data } = payload;
        const db = getDatabase();

        try {
            // Update user base fields
            await db.user.update({
                where: { id: client.userId },
                data: {
                    ...(data.name !== undefined && { name: data.name }),
                    ...(data.age !== undefined && { age: data.age }),
                    ...(data.avatar !== undefined && { avatar: data.avatar }),
                    ...(data.city !== undefined && { city: data.city })
                }
            });

            // Update profile fields
            if (data.bio !== undefined || data.socialVibe !== undefined || data.location !== undefined) {
                await db.profile.update({
                    where: { userId: client.userId },
                    data: {
                        ...(data.bio !== undefined && { bio: data.bio }),
                        ...(data.socialVibe !== undefined && { socialVibe: data.socialVibe }),
                        ...(data.location?.country !== undefined && { country: data.location.country }),
                        ...(data.location?.region !== undefined && { region: data.location.region }),
                        ...(data.location?.city !== undefined && { city: data.location.city })
                    }
                });
            }

            // TODO: Update interests, skills, intentions (tag management)

            logger.info(`[Profile] Updated profile for user: ${client.userId}`);

            // Re-fetch and return updated profile
            const { mapUserToProfile, profileInclude } = await import('@/services/userMapper');
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
