import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetProfile, WSResponse_GetProfile } from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { mapUserToProfile, profileInclude } from '@/services/userMapper';
import { isPremium } from '@/services/subscriptionService';
import { hasActiveBoost } from '@/services/boostService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetProfile>('get-profile', async (client: Client): Promise<WSResponse_GetProfile> => {
    const db = getDatabase();

    try {
        const [user, premium, boosted] = await Promise.all([
            db.user.findUnique({ where: { id: client.userId }, include: profileInclude }),
            isPremium(client.userId),
            hasActiveBoost(client.userId)
        ]);

        if (!user) {
            return { command: 'get-profile', payload: { error: 'User not found' } };
        }

        return {
            command: 'get-profile',
            payload: { user: mapUserToProfile(user, { isPremium: premium, isBoosted: boosted }) }
        };
    } catch (error) {
        logger.error('[Profile] Get profile error', error);
        return { command: 'get-profile', payload: { error: 'Internal error' } };
    }
});
