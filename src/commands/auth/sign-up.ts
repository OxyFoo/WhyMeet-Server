import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_SignUp, WSResponse_SignUp } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_SignUp>('sign-up', async (_client: Client, payload): Promise<WSResponse_SignUp> => {
    const { name, email, password: _password } = payload;
    const db = getDatabase();

    try {
        const existing = await db.user.findUnique({ where: { email } });
        if (existing) {
            return { command: 'sign-up', payload: { error: 'Email already in use' } };
        }

        // TODO: Hash password
        const user = await db.user.create({
            data: {
                name,
                email,
                passwordHash: 'TODO_HASHED',
                age: 0,
                profile: { create: {} }
            },
            include: { profile: true }
        });

        logger.info(`[Auth] User signed up: ${user.id}`);

        return {
            command: 'sign-up',
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
                    interests: [],
                    skills: [],
                    intentions: [],
                    location: {
                        country: user.profile?.country ?? '',
                        region: user.profile?.region ?? '',
                        city: user.profile?.city ?? ''
                    },
                    stats: { connections: 0, matches: 0, vibes: 0 }
                }
            }
        };
    } catch (error) {
        logger.error('[Auth] Sign-up error', error);
        return { command: 'sign-up', payload: { error: 'Internal error' } };
    }
});
