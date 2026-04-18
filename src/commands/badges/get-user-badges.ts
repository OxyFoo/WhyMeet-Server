import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetUserBadges, WSResponse_GetUserBadges } from '@oxyfoo/whymeet-types';
import { getUserBadges } from '@/services/badgeService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetUserBadges>(
    'get-user-badges',
    async (client: Client, payload): Promise<WSResponse_GetUserBadges> => {
        try {
            const { userId } = payload;

            if (!userId) {
                return { command: 'get-user-badges', payload: { error: 'userId required' } };
            }

            const allBadges = await getUserBadges(userId);
            // Only return earned badges for other users
            const earnedBadges = allBadges.filter((b) => b.earned);

            return { command: 'get-user-badges', payload: { badges: earnedBadges } };
        } catch (error) {
            logger.error('[Badges] get-user-badges error', error);
            return { command: 'get-user-badges', payload: { error: 'Failed to get badges' } };
        }
    }
);
