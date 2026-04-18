import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetBadges, WSResponse_GetBadges } from '@oxyfoo/whymeet-types';
import { getUserBadges, checkAndAwardBadges } from '@/services/badgeService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetBadges>('get-badges', async (client: Client): Promise<WSResponse_GetBadges> => {
    try {
        // Refresh badges before returning
        await checkAndAwardBadges(client.userId);
        const badges = await getUserBadges(client.userId);
        return { command: 'get-badges', payload: { badges } };
    } catch (error) {
        logger.error('[Badges] get-badges error', error);
        return { command: 'get-badges', payload: { error: 'Failed to get badges' } };
    }
});
