import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_SignIn, WSResponse_SignIn } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_SignIn>('sign-in', async (client: Client, payload): Promise<WSResponse_SignIn> => {
    const { email, password: _password } = payload;
    const db = getDatabase();

    try {
        const user = await db.user.findUnique({
            where: { email },
            include: { profile: true, tags: { include: { tag: true } }, intentions: { include: { intention: true } } }
        });

        if (!user) {
            return { command: 'sign-in', payload: { error: 'Invalid credentials' } };
        }

        // TODO: Verify password hash
        // TODO: Generate JWT token

        client.userId = user.id;
        client.authenticated = true;

        logger.info(`[Auth] User signed in: ${user.id}`);

        return {
            command: 'sign-in',
            payload: {
                token: 'TODO_JWT_TOKEN',
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
        logger.error('[Auth] Sign-in error', error);
        return { command: 'sign-in', payload: { error: 'Internal error' } };
    }
});
