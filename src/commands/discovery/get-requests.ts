import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type {
    WSRequest_GetRequests,
    WSResponse_GetRequests,
    Gender,
    PreferredPeriod,
    ProfilePhoto,
    IntentionKey,
    IntentionCategoryKey,
    SocialVibe
} from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { computeAge } from '@/services/userMapper';
import { isPremium, getPremiumUserIds } from '@/services/subscriptionService';
import { getBoostedUserIds } from '@/services/boostService';
import { decodeCursor, encodeCursor, resolveLimit } from '@/services/cursorPagination';
import { getHiddenIncomingRequestSenderIds, incomingRequestVisibilityFilter } from '@/services/matchRequestVisibility';
import { computeMatchScore } from '@/services/scoring';
import type { ScoringCandidate, ScoringContext } from '@/services/scoring';
import { buildTagScoringData } from '@/services/discoveryPipeline';
import { normalizeActiveIntentionKeys, normalizeActiveIntentionCategoryKeys } from '@/services/intentionKeys';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetRequests>(
    'get-requests',
    async (client: Client, payload): Promise<WSResponse_GetRequests> => {
        const db = getDatabase();

        try {
            const limit = resolveLimit(payload?.limit);
            const decoded = decodeCursor(payload?.cursor);

            const hiddenRequestSenderIds = await getHiddenIncomingRequestSenderIds(client.userId);

            const cursorFilter = decoded
                ? {
                      OR: [
                          { matchedAt: { lt: new Date(decoded.k) } },
                          {
                              AND: [{ matchedAt: new Date(decoded.k) }, { id: { lt: decoded.i } }]
                          }
                      ]
                  }
                : undefined;

            const [receivedMatches, userIsPremium] = await Promise.all([
                db.match.findMany({
                    where: {
                        receiverId: client.userId,
                        category: 'like',
                        mutual: false,
                        sender: {
                            banned: false,
                            suspended: false,
                            deleted: false
                        },
                        ...incomingRequestVisibilityFilter(hiddenRequestSenderIds),
                        ...(cursorFilter ?? {})
                    },
                    include: {
                        sender: {
                            include: {
                                profile: true,
                                photos: { orderBy: { position: 'asc' } },
                                tags: { include: { tag: true } }
                            }
                        }
                    },
                    orderBy: [{ matchedAt: 'desc' }, { id: 'desc' }],
                    take: limit + 1
                }),
                isPremium(client.userId)
            ]);

            const hasMore = receivedMatches.length > limit;
            const sliced = hasMore ? receivedMatches.slice(0, limit) : receivedMatches;
            const last = sliced[sliced.length - 1];
            const nextCursor = hasMore && last ? encodeCursor(last.matchedAt, last.id) : null;

            const senderIds = sliced.map((m) => m.sender.id);
            const [senderPremiumIds, boostedIds, currentUser] = await Promise.all([
                getPremiumUserIds(senderIds),
                getBoostedUserIds(),
                db.user.findUnique({
                    where: { id: client.userId },
                    include: { profile: true, tags: { include: { tag: true } } }
                })
            ]);

            // Build a scoring context for the receiver (current user) so we can
            // compute a compatibility score for every incoming request sender.
            let scoringCtx: ScoringContext | null = null;
            if (currentUser?.profile) {
                const myTagData = buildTagScoringData(currentUser.tags);
                scoringCtx = {
                    myIntentionKeys: normalizeActiveIntentionKeys(currentUser.profile.intentionKeys ?? []),
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
            }

            const requests = sliced.map((m) => {
                let compatibilityScore: number | undefined;
                if (scoringCtx) {
                    const theirTagData = buildTagScoringData(m.sender.tags);
                    const scoringCandidate: ScoringCandidate = {
                        intentionKeys: normalizeActiveIntentionKeys(m.sender.profile?.intentionKeys ?? []),
                        intentionCategoryKeys: normalizeActiveIntentionCategoryKeys(
                            m.sender.profile?.intentionCategoryKeys ?? []
                        ),
                        interestLabels: theirTagData.interestLabels,
                        skillLabels: theirTagData.skillLabels,
                        domainCounts: theirTagData.domainCounts,
                        spokenLanguages: m.sender.profile?.spokenLanguages ?? [],
                        latitude: m.sender.profile?.latitude ?? null,
                        longitude: m.sender.profile?.longitude ?? null,
                        bio: m.sender.profile?.bio ?? '',
                        photoCount: (m.sender.photos ?? []).length,
                        verified: m.sender.verified,
                        tagCount: (m.sender.tags ?? []).length,
                        preferredPeriod: (m.sender.preferredPeriod ?? 'any') as PreferredPeriod,
                        socialVibe: (m.sender.profile?.socialVibe ?? 'balanced') as SocialVibe,
                        reportCount: 0
                    };
                    compatibilityScore = computeMatchScore(scoringCtx, scoringCandidate).total;
                }

                return {
                    id: m.id,
                    sender: {
                        id: m.sender.id,
                        name: m.sender.name,
                        age: computeAge(m.sender.birthDate),
                        birthDate: m.sender.birthDate?.toISOString() ?? null,
                        gender: (m.sender.gender || 'male') as Gender,
                        photos: (m.sender.photos ?? []).map((p) => ({
                            id: p.id,
                            key: userIsPremium ? p.key : p.keyBlurred,
                            description: p.description,
                            position: p.position
                        })) as ProfilePhoto[],
                        city: m.sender.city,
                        verified: m.sender.verified,
                        suspended: m.sender.suspended ?? false,
                        banned: m.sender.banned ?? false,
                        preferredPeriod: (m.sender.preferredPeriod ?? 'any') as PreferredPeriod,
                        isPremium: senderPremiumIds.has(m.sender.id),
                        isBoosted: boostedIds.has(m.sender.id),
                        badges: []
                    },
                    intentionKeys: (m.sender.profile?.intentionKeys ?? []) as IntentionKey[],
                    categoryKey: (m.categoryKey || undefined) as IntentionCategoryKey | undefined,
                    intentionKey: (m.intentionKey || undefined) as IntentionKey | undefined,
                    matchContext: m.matchContext,
                    sentAt: m.matchedAt.toISOString(),
                    compatibilityScore
                };
            });

            logger.debug(`[Discovery] ${requests.length} requests for user: ${client.userId}`);
            return { command: 'get-requests', payload: { requests, nextCursor } };
        } catch (error) {
            logger.error('[Discovery] Get requests error', error);
            return { command: 'get-requests', payload: { error: 'Internal error' } };
        }
    }
);
