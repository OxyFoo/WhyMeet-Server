import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type {
    WSRequest_GetUserProfile,
    WSResponse_GetUserProfile,
    IntentionKey,
    PreferredPeriod,
    SocialVibe
} from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { mapUserToCandidate, candidateInclude } from '@/services/userMapper';
import { computeMatchScore } from '@/services/scoring';
import type { ScoringCandidate, ScoringContext } from '@/services/scoring';
import { buildTagScoringData } from '@/services/discoveryPipeline';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetUserProfile>(
    'get-user-profile',
    async (client: Client, payload): Promise<WSResponse_GetUserProfile> => {
        const db = getDatabase();
        const { userId } = payload;

        if (!userId || typeof userId !== 'string') {
            return { command: 'get-user-profile', payload: { error: 'Invalid userId' } };
        }

        try {
            // Check if target user is blocked
            const block = await db.block.findFirst({
                where: {
                    OR: [
                        { blockerId: client.userId, blockedId: userId },
                        { blockerId: userId, blockedId: client.userId }
                    ]
                }
            });

            if (block) {
                return { command: 'get-user-profile', payload: { error: 'User not found' } };
            }

            // Fetch target user
            const targetUser = await db.user.findUnique({
                where: { id: userId },
                include: candidateInclude
            });

            if (!targetUser) {
                return { command: 'get-user-profile', payload: { error: 'User not found' } };
            }

            if (targetUser.banned || targetUser.suspended || targetUser.deleted) {
                return { command: 'get-user-profile', payload: { error: 'User not found' } };
            }

            // Parallel: current user profile (distance) + interaction checks + mutual match
            const [currentUser, existingMatch, existingReport, mutualMatch] = await Promise.all([
                db.user.findUnique({
                    where: { id: client.userId },
                    include: { profile: true, tags: { include: { tag: true } } }
                }),
                db.match.findFirst({ where: { senderId: client.userId, receiverId: userId } }),
                db.report.findFirst({ where: { reporterId: client.userId, reportedId: userId } }),
                db.match.findFirst({
                    where: {
                        mutual: true,
                        OR: [
                            { senderId: client.userId, receiverId: userId },
                            { senderId: userId, receiverId: client.userId }
                        ]
                    }
                })
            ]);

            const refLatLng = currentUser?.profile
                ? { latitude: currentUser.profile.latitude, longitude: currentUser.profile.longitude }
                : undefined;

            const candidate = mapUserToCandidate(targetUser, undefined, refLatLng);

            // Compute affinity score
            if (currentUser?.profile) {
                const myTagData = buildTagScoringData(currentUser.tags);
                const scoringCtx: ScoringContext = {
                    myIntentions: (currentUser.profile.intentions ?? []) as IntentionKey[],
                    myInterestLabels: myTagData.interestLabels,
                    mySkillLabels: myTagData.skillLabels,
                    myDomainCounts: myTagData.domainCounts,
                    myLanguages: currentUser.profile.spokenLanguages ?? [],
                    myLatitude: currentUser.profile.latitude,
                    myLongitude: currentUser.profile.longitude,
                    myPreferredPeriod: (currentUser.preferredPeriod ?? 'any') as PreferredPeriod,
                    mySocialVibe: (currentUser.profile.socialVibe ?? 'balanced') as SocialVibe,
                    maxDistance: 100,
                    isRemote: false
                };
                const theirTagData = buildTagScoringData(targetUser.tags);
                const scoringCandidate: ScoringCandidate = {
                    intentions: (targetUser.profile?.intentions ?? []) as IntentionKey[],
                    interestLabels: theirTagData.interestLabels,
                    skillLabels: theirTagData.skillLabels,
                    domainCounts: theirTagData.domainCounts,
                    spokenLanguages: targetUser.profile?.spokenLanguages ?? [],
                    latitude: targetUser.profile?.latitude ?? null,
                    longitude: targetUser.profile?.longitude ?? null,
                    bio: targetUser.profile?.bio ?? '',
                    photoCount: (targetUser.photos ?? []).length,
                    verified: targetUser.verified,
                    tagCount: (targetUser.tags ?? []).length,
                    preferredPeriod: (targetUser.preferredPeriod ?? 'any') as PreferredPeriod,
                    socialVibe: (targetUser.profile?.socialVibe ?? 'balanced') as SocialVibe,
                    reportCount: 0
                };
                candidate.score = computeMatchScore(scoringCtx, scoringCandidate).total;
            }

            if (existingMatch || existingReport) {
                candidate.alreadyInteracted = true;
            }
            if (mutualMatch) {
                candidate.alreadyMatched = true;
            }

            return { command: 'get-user-profile', payload: { candidate } };
        } catch (error) {
            logger.error('[Profile] Get user profile error', error);
            return { command: 'get-user-profile', payload: { error: 'Internal error' } };
        }
    }
);
