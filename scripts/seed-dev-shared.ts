import { PrismaClient } from '@prisma/client';
import { deleteImagePair } from '../src/services/photoStorageService';
import { resolveStorageKey } from '../src/services/storageService';

export const SEED_EMAIL_SUFFIX = '@seed.whymeet.dev';
export const SEED_STORAGE_CONCURRENCY = 6;

interface StoredImagePair {
    key: string;
    keyBlurred: string;
}

export interface ResetSeedDevResult {
    deletedUsers: number;
    deletedActivities: number;
    deletedConversations: number;
    deletedProfileImages: number;
    deletedActivityImages: number;
    deletedFeedbacks: number;
    deletedAuditLogs: number;
    deletedApiUsageEvents: number;
    deletedEmailLogs: number;
}

async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
        while (nextIndex < items.length) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            results[currentIndex] = await mapper(items[currentIndex] as T, currentIndex);
        }
    }

    const workerCount = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}

async function deleteStoredImagePairs(photos: StoredImagePair[]): Promise<number> {
    const deletablePhotos = photos.filter(
        (photo) => resolveStorageKey(photo.key) !== null || resolveStorageKey(photo.keyBlurred) !== null
    );

    await mapWithConcurrency(deletablePhotos, SEED_STORAGE_CONCURRENCY, async (photo) => {
        await deleteImagePair(photo.key, photo.keyBlurred);
        return null;
    });

    return deletablePhotos.length;
}

export async function resetSeedDevData(prisma: PrismaClient): Promise<ResetSeedDevResult> {
    const seedUsers = await prisma.user.findMany({
        where: { email: { endsWith: SEED_EMAIL_SUFFIX } },
        select: { id: true }
    });

    if (seedUsers.length === 0) {
        return {
            deletedUsers: 0,
            deletedActivities: 0,
            deletedConversations: 0,
            deletedProfileImages: 0,
            deletedActivityImages: 0,
            deletedFeedbacks: 0,
            deletedAuditLogs: 0,
            deletedApiUsageEvents: 0,
            deletedEmailLogs: 0
        };
    }

    const seedUserIds = seedUsers.map((user) => user.id);

    const [seedActivities, profilePhotos, seedParticipations] = await Promise.all([
        prisma.activity.findMany({
            where: { hostId: { in: seedUserIds } },
            select: { id: true, conversationId: true }
        }),
        prisma.profilePhoto.findMany({
            where: { userId: { in: seedUserIds } },
            select: { key: true, keyBlurred: true }
        }),
        prisma.conversationParticipant.findMany({
            where: { userId: { in: seedUserIds } },
            select: { conversationId: true, conversation: { select: { isGroup: true } } }
        })
    ]);

    const seedActivityIds = seedActivities.map((activity) => activity.id);
    const activityPhotos =
        seedActivityIds.length === 0
            ? []
            : await prisma.activityPhoto.findMany({
                  where: { activityId: { in: seedActivityIds } },
                  select: { key: true, keyBlurred: true }
              });

    const seedHostedConversationIds = seedActivities
        .map((activity) => activity.conversationId)
        .filter((conversationId): conversationId is string => typeof conversationId === 'string');

    const seedDmConversationIds = seedParticipations
        .filter((participation) => participation.conversation.isGroup === false)
        .map((participation) => participation.conversationId);

    const conversationIdsToDelete = [...new Set([...seedDmConversationIds, ...seedHostedConversationIds])];

    const [deletedProfileImages, deletedActivityImages] = await Promise.all([
        deleteStoredImagePairs(profilePhotos),
        deleteStoredImagePairs(activityPhotos)
    ]);

    const deletedRows = await prisma.$transaction(async (tx) => {
        if (seedActivityIds.length > 0 && seedHostedConversationIds.length > 0) {
            await tx.activity.updateMany({
                where: {
                    id: { in: seedActivityIds },
                    conversationId: { in: seedHostedConversationIds }
                },
                data: { conversationId: null }
            });
        }

        const deletedConversations =
            conversationIdsToDelete.length === 0
                ? 0
                : (
                      await tx.conversation.deleteMany({
                          where: { id: { in: conversationIdsToDelete } }
                      })
                  ).count;

        const deletedFeedbacks = (
            await tx.feedback.deleteMany({
                where: { userId: { in: seedUserIds } }
            })
        ).count;

        const deletedAuditLogs = (
            await tx.auditLog.deleteMany({
                where:
                    seedActivityIds.length === 0
                        ? { userId: { in: seedUserIds } }
                        : {
                              OR: [{ userId: { in: seedUserIds } }, { targetActivityId: { in: seedActivityIds } }]
                          }
            })
        ).count;

        const deletedApiUsageEvents = (
            await tx.apiUsageEvent.deleteMany({
                where: { userId: { in: seedUserIds } }
            })
        ).count;

        const deletedEmailLogs = (
            await tx.emailLog.deleteMany({
                where: {
                    OR: [{ recipientUserId: { in: seedUserIds } }, { recipientEmail: { endsWith: SEED_EMAIL_SUFFIX } }]
                }
            })
        ).count;

        const deletedUsers = (
            await tx.user.deleteMany({
                where: { id: { in: seedUserIds } }
            })
        ).count;

        return {
            deletedUsers,
            deletedConversations,
            deletedFeedbacks,
            deletedAuditLogs,
            deletedApiUsageEvents,
            deletedEmailLogs
        };
    });

    return {
        deletedUsers: deletedRows.deletedUsers,
        deletedActivities: seedActivityIds.length,
        deletedConversations: deletedRows.deletedConversations,
        deletedProfileImages,
        deletedActivityImages,
        deletedFeedbacks: deletedRows.deletedFeedbacks,
        deletedAuditLogs: deletedRows.deletedAuditLogs,
        deletedApiUsageEvents: deletedRows.deletedApiUsageEvents,
        deletedEmailLogs: deletedRows.deletedEmailLogs
    };
}
