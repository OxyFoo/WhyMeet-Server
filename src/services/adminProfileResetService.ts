import { logger } from '@/config/logger';
import { getDatabase } from '@/services/database';
import { deleteImagePair } from '@/services/photoStorageService';
import { invalidateCandidate } from '@/services/candidateCache';
import { invalidatePipelineSetup } from '@/services/pipelineSetupCache';
import { invalidateDiscoveryCounts } from '@/services/discoveryCountsCache';
import { invalidateActivityCatalogCache, invalidateActivityDiscoveryCache } from '@/services/activityDiscoveryService';

const VERIFIED_PROFILE_BADGE_KEY = 'verified_profile';

export class AdminProfileResetUserNotFoundError extends Error {
    constructor(userId: string) {
        super(`User not found: ${userId}`);
        this.name = 'AdminProfileResetUserNotFoundError';
    }
}

export type AdminProfileResetResult = {
    ok: true;
    deletedPhotoCount: number;
    deletedTagCount: number;
    clearedVerifiedBadge: boolean;
};

function isPrismaNotFoundError(error: unknown): boolean {
    return (
        typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2025'
    );
}

function logRejectedSettledResult(label: string, result: PromiseSettledResult<unknown>): void {
    if (result.status === 'rejected') {
        logger.warn(`[AdminProfileReset] ${label} failed`, result.reason);
    }
}

export async function resetUserProfileToInitialState(userId: string): Promise<AdminProfileResetResult> {
    const db = getDatabase();
    const existing = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!existing) throw new AdminProfileResetUserNotFoundError(userId);

    const photos = await db.profilePhoto.findMany({
        where: { userId },
        select: { key: true, keyBlurred: true }
    });

    try {
        const result = await db.$transaction(async (tx) => {
            await tx.user.update({
                where: { id: userId },
                data: {
                    verified: false,
                    birthDate: null,
                    birthDateLastChangedAt: null,
                    gender: '',
                    city: '',
                    preferredPeriod: 'any'
                }
            });

            await tx.profile.upsert({
                where: { userId },
                create: {
                    userId,
                    bio: '',
                    socialVibe: 'balanced',
                    country: '',
                    region: '',
                    city: '',
                    latitude: null,
                    longitude: null,
                    intentionKeys: [],
                    intentionCategoryKeys: [],
                    spokenLanguages: ['fr']
                },
                update: {
                    bio: '',
                    socialVibe: 'balanced',
                    country: '',
                    region: '',
                    city: '',
                    latitude: null,
                    longitude: null,
                    intentionKeys: [],
                    intentionCategoryKeys: [],
                    spokenLanguages: ['fr']
                }
            });

            const [deletedPhotos, deletedTags, deletedVerifiedBadges] = await Promise.all([
                tx.profilePhoto.deleteMany({ where: { userId } }),
                tx.userTag.deleteMany({ where: { userId } }),
                tx.userBadge.deleteMany({ where: { userId, badgeKey: VERIFIED_PROFILE_BADGE_KEY } })
            ]);

            return {
                ok: true as const,
                deletedPhotoCount: deletedPhotos.count,
                deletedTagCount: deletedTags.count,
                clearedVerifiedBadge: deletedVerifiedBadges.count > 0
            };
        });

        const photoCleanupResults = await Promise.allSettled(
            photos.map((photo) => deleteImagePair(photo.key, photo.keyBlurred))
        );
        photoCleanupResults.forEach((cleanupResult) => logRejectedSettledResult('photo cleanup', cleanupResult));

        const cacheInvalidationResults = await Promise.allSettled([
            invalidateCandidate(userId),
            invalidatePipelineSetup(userId),
            invalidateDiscoveryCounts(userId),
            invalidateActivityDiscoveryCache(userId),
            invalidateActivityCatalogCache()
        ]);
        cacheInvalidationResults.forEach((cacheResult) => logRejectedSettledResult('cache invalidation', cacheResult));

        return result;
    } catch (error) {
        if (isPrismaNotFoundError(error)) throw new AdminProfileResetUserNotFoundError(userId);
        throw error;
    }
}
