import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_Skip, WSResponse_Skip } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { useSwipe } from '@/services/swipeQuotaService';
import { addExcluded } from '@/services/excludeCache';
import { logger } from '@/config/logger';

registerCommand<WSRequest_Skip>('skip', async (client: Client, payload): Promise<WSResponse_Skip> => {
    const { candidateId } = payload;
    const db = getDatabase();

    try {
        // Check and consume swipe quota
        try {
            await useSwipe(client.userId);
        } catch (err) {
            if (err instanceof Error && err.message === 'quota_exceeded') {
                return { command: 'skip', payload: { success: false } };
            }
            throw err;
        }
        addExcluded(client.userId, candidateId).catch(() => {});
        await db.match.upsert({
            where: {
                senderId_receiverId_category: { senderId: client.userId, receiverId: candidateId, category: 'skip' }
            },
            update: {},
            create: { senderId: client.userId, receiverId: candidateId, category: 'skip' }
        });

        logger.debug(`[Discovery] User ${client.userId} skipped ${candidateId}`);
        return { command: 'skip', payload: { success: true } };
    } catch (error) {
        logger.error('[Discovery] Skip error', error);
        return { command: 'skip', payload: { success: false } };
    }
});
