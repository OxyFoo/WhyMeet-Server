import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_ClaimBadgeReward, WSResponse_ClaimBadgeReward } from '@oxyfoo/whymeet-types';
import { getBadgeDefinitions } from '@/services/badgeService';
import { signAppleOffer } from '@/services/offerSigningService';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

// TODO: Define product IDs
const SUBSCRIPTION_PRODUCT_ID = 'com.whymeet.sub.monthly';

registerCommand<WSRequest_ClaimBadgeReward>(
    'claim-badge-reward',
    async (client: Client, payload): Promise<WSResponse_ClaimBadgeReward> => {
        try {
            const { badgeKey, platform } = payload;
            const db = getDatabase();

            if (!badgeKey || !platform) {
                return { command: 'claim-badge-reward', payload: { error: 'badgeKey and platform required' } };
            }

            if (platform !== 'ios' && platform !== 'android') {
                return { command: 'claim-badge-reward', payload: { error: 'Invalid platform' } };
            }

            // Check badge is earned
            const userBadge = await db.userBadge.findUnique({
                where: { userId_badgeKey: { userId: client.userId, badgeKey } }
            });

            if (!userBadge || !userBadge.earned) {
                return { command: 'claim-badge-reward', payload: { error: 'Badge not earned' } };
            }

            // Check badge has a reward
            const defs = await getBadgeDefinitions();
            const def = defs.find((d) => d.key === badgeKey);

            if (!def || !def.rewardType) {
                return { command: 'claim-badge-reward', payload: { error: 'No reward for this badge' } };
            }

            // Check not already claimed
            if (userBadge.rewardClaimedAt) {
                return { command: 'claim-badge-reward', payload: { error: 'Reward already claimed' } };
            }

            // Mark as claimed
            await db.userBadge.update({
                where: { userId_badgeKey: { userId: client.userId, badgeKey } },
                data: { rewardClaimedAt: new Date() }
            });

            if (platform === 'ios') {
                const offerId = def.rewardOfferIdApple;
                if (!offerId) {
                    return { command: 'claim-badge-reward', payload: { error: 'Apple offer not configured' } };
                }

                try {
                    const signing = signAppleOffer(SUBSCRIPTION_PRODUCT_ID, offerId, client.userId);
                    return {
                        command: 'claim-badge-reward',
                        payload: {
                            offerId,
                            platform: 'ios',
                            keyIdentifier: signing.keyIdentifier,
                            nonce: signing.nonce,
                            signature: signing.signature,
                            timestamp: signing.timestamp
                        }
                    };
                } catch (err) {
                    // Rollback claim on signing failure
                    await db.userBadge.update({
                        where: { userId_badgeKey: { userId: client.userId, badgeKey } },
                        data: { rewardClaimedAt: null }
                    });
                    logger.error('[ClaimBadgeReward] Apple signing failed', err);
                    return { command: 'claim-badge-reward', payload: { error: 'Signing failed' } };
                }
            } else {
                // Android: return the offer ID, client resolves offerToken from fetched products
                const offerId = def.rewardOfferIdGoogle;
                if (!offerId) {
                    return { command: 'claim-badge-reward', payload: { error: 'Google offer not configured' } };
                }

                return {
                    command: 'claim-badge-reward',
                    payload: { offerId, platform: 'android' }
                };
            }
        } catch (error) {
            logger.error('[ClaimBadgeReward] Error', error);
            return { command: 'claim-badge-reward', payload: { error: 'Failed to claim reward' } };
        }
    }
);
