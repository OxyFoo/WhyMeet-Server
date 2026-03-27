import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetProfile, WSResponse_GetProfile } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetProfile>('get-profile', async (client: Client): Promise<WSResponse_GetProfile> => {
    const db = getDatabase();

    try {
        const user = await db.user.findUnique({
            where: { id: client.userId },
            include: {
                profile: true,
                tags: { include: { tag: true } },
                intentions: { include: { intention: true } }
            }
        });

        if (!user) {
            return { command: 'get-profile', payload: { error: 'User not found' } };
        }

        return {
            command: 'get-profile',
            payload: {
                user: {
                    id: user.id,
                    name: user.name,
                    age: user.age,
                    avatar: user.avatar,
                    city: user.city,
                    verified: user.verified,
                    bio: user.profile?.bio ?? '',
                    socialVibe: (user.profile?.socialVibe ?? 'chill') as 'chill',
                    interests: user.tags
                        .filter((t) => t.type === 'interest')
                        .map((t) => ({ id: t.tag.id, label: t.tag.label })),
                    skills: user.tags
                        .filter((t) => t.type === 'skill')
                        .map((t) => ({ id: t.tag.id, label: t.tag.label })),
                    intentions: user.intentions.map((ui) => ({
                        id: ui.intention.id,
                        category: ui.intention.category as 'dating',
                        label: ui.intention.label,
                        description: ui.intention.description,
                        tags: []
                    })),
                    location: {
                        country: user.profile?.country ?? '',
                        region: user.profile?.region ?? '',
                        city: user.profile?.city ?? ''
                    },
                    stats: {
                        connections: user.profile?.statConnections ?? 0,
                        matches: user.profile?.statMatches ?? 0,
                        vibes: user.profile?.statVibes ?? 0
                    }
                }
            }
        };
    } catch (error) {
        logger.error('[Profile] Get profile error', error);
        return { command: 'get-profile', payload: { error: 'Internal error' } };
    }
});
