import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_Skip, WSResponse_Skip } from '@oxyfoo/whymeet-types';
import { getIntention } from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { useSwipeQuota } from '@/services/swipeQuotaService';
import { addExcluded } from '@/services/excludeCache';
import { validateIntentionSelection } from '@/config/validation';
import { normalizeActiveIntentionSelection } from '@/services/intentionKeys';
import { logger } from '@/config/logger';

registerCommand<WSRequest_Skip>('skip', async (client: Client, payload): Promise<WSResponse_Skip> => {
    const { candidateId, selection } = payload;
    const db = getDatabase();
    const selectionError = selection ? validateIntentionSelection(selection) : null;
    if (selectionError) return { command: 'skip', payload: { success: false } };

    const normalizedSelection = selection ? normalizeActiveIntentionSelection(selection) : null;
    const selectedIntention = normalizedSelection ? getIntention(normalizedSelection.intentionKey) : null;
    const intentionData = selectedIntention
        ? {
              categoryKey: selectedIntention.categoryKey,
              intentionKey: selectedIntention.key
          }
        : {};

    try {
        // Check and consume swipe quota
        try {
            await useSwipeQuota(client.userId);
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
            update: intentionData,
            create: { senderId: client.userId, receiverId: candidateId, category: 'skip', ...intentionData }
        });

        logger.debug(`[Discovery] User ${client.userId} skipped ${candidateId}`);
        return { command: 'skip', payload: { success: true } };
    } catch (error) {
        logger.error('[Discovery] Skip error', error);
        return { command: 'skip', payload: { success: false } };
    }
});
