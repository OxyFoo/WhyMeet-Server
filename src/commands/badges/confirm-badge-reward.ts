import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_ConfirmBadgeReward, WSResponse_ConfirmBadgeReward } from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

/**
 * Confirm or cancel an Android badge reward purchase started via `claim-badge-reward`.
 *
 * - success=true  → moves the row from `rewardPendingAt` → `rewardClaimedAt`.
 * - success=false → releases the pending slot so the user can retry.
 *
 * iOS does not need this: the signed-offer flow is fire-and-forget and the row
 * is marked claimed atomically in `claim-badge-reward`.
 */
registerCommand<WSRequest_ConfirmBadgeReward>(
    'confirm-badge-reward',
    async (client: Client, payload): Promise<WSResponse_ConfirmBadgeReward> => {
        try {
            const { badgeKey, platform, success } = payload;
            if (!badgeKey || platform !== 'android') {
                return {
                    command: 'confirm-badge-reward',
                    payload: { error: 'invalid_payload', confirmed: false }
                };
            }

            const db = getDatabase();
            const row = await db.userBadge.findUnique({
                where: { userId_badgeKey: { userId: client.userId, badgeKey } }
            });
            if (!row) {
                return {
                    command: 'confirm-badge-reward',
                    payload: { error: 'badge_not_found', confirmed: false }
                };
            }

            if (success) {
                if (row.rewardClaimedAt) {
                    return { command: 'confirm-badge-reward', payload: { confirmed: true } };
                }
                await db.userBadge.update({
                    where: { userId_badgeKey: { userId: client.userId, badgeKey } },
                    data: { rewardClaimedAt: new Date(), rewardPendingAt: null }
                });
                return { command: 'confirm-badge-reward', payload: { confirmed: true } };
            }

            // Failure → release pending slot if still pending.
            if (row.rewardPendingAt && !row.rewardClaimedAt) {
                await db.userBadge.update({
                    where: { userId_badgeKey: { userId: client.userId, badgeKey } },
                    data: { rewardPendingAt: null }
                });
            }
            return { command: 'confirm-badge-reward', payload: { confirmed: false } };
        } catch (error) {
            logger.error('[ConfirmBadgeReward] Error', error);
            return {
                command: 'confirm-badge-reward',
                payload: { error: 'internal_error', confirmed: false }
            };
        }
    }
);
