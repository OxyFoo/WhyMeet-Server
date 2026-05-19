const mockGetDatabase = jest.fn();
const mockDeleteImagePair = jest.fn();
const mockInvalidateCandidate = jest.fn();
const mockInvalidatePipelineSetup = jest.fn();
const mockInvalidateDiscoveryCounts = jest.fn();
const mockInvalidateActivityDiscoveryCache = jest.fn();
const mockInvalidateActivityCatalogCache = jest.fn();

jest.mock('@/services/database', () => ({ getDatabase: mockGetDatabase }));
jest.mock('@/services/photoStorageService', () => ({ deleteImagePair: mockDeleteImagePair }));
jest.mock('@/services/candidateCache', () => ({ invalidateCandidate: mockInvalidateCandidate }));
jest.mock('@/services/pipelineSetupCache', () => ({ invalidatePipelineSetup: mockInvalidatePipelineSetup }));
jest.mock('@/services/discoveryCountsCache', () => ({ invalidateDiscoveryCounts: mockInvalidateDiscoveryCounts }));
jest.mock('@/services/activityDiscoveryService', () => ({
    invalidateActivityDiscoveryCache: mockInvalidateActivityDiscoveryCache,
    invalidateActivityCatalogCache: mockInvalidateActivityCatalogCache
}));
jest.mock('@/config/logger', () => ({
    logger: {
        warn: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        success: jest.fn()
    }
}));

import {
    AdminProfileResetUserNotFoundError,
    resetUserProfileToInitialState
} from '@/services/adminProfileResetService';

function makeDb() {
    const tx = {
        user: { update: jest.fn().mockResolvedValue({}) },
        profile: { upsert: jest.fn().mockResolvedValue({}) },
        profilePhoto: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
        userTag: { deleteMany: jest.fn().mockResolvedValue({ count: 10 }) },
        userBadge: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };

    const db = {
        user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-1' }) },
        profilePhoto: {
            findMany: jest.fn().mockResolvedValue([
                { key: 'photos/user-1/a.webp', keyBlurred: 'photos/user-1/a.blurred.webp' },
                { key: 'photos/user-1/b.webp', keyBlurred: 'photos/user-1/b.blurred.webp' }
            ])
        },
        $transaction: jest.fn((callback: (transactionClient: typeof tx) => Promise<unknown>) => callback(tx))
    };

    return { db, tx };
}

describe('resetUserProfileToInitialState', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDeleteImagePair.mockResolvedValue(undefined);
        mockInvalidateCandidate.mockResolvedValue(undefined);
        mockInvalidatePipelineSetup.mockResolvedValue(undefined);
        mockInvalidateDiscoveryCounts.mockResolvedValue(undefined);
        mockInvalidateActivityDiscoveryCache.mockResolvedValue(undefined);
        mockInvalidateActivityCatalogCache.mockResolvedValue(undefined);
    });

    it('resets profile fields to their initial values without touching the username', async () => {
        const { db, tx } = makeDb();
        mockGetDatabase.mockReturnValue(db);

        const result = await resetUserProfileToInitialState('user-1');

        expect(result).toEqual({
            ok: true,
            deletedPhotoCount: 2,
            deletedTagCount: 10,
            clearedVerifiedBadge: true
        });

        expect(tx.user.update).toHaveBeenCalledWith({
            where: { id: 'user-1' },
            data: {
                verified: false,
                birthDate: null,
                birthDateLastChangedAt: null,
                gender: '',
                city: '',
                preferredPeriod: 'any'
            }
        });
        expect(tx.user.update.mock.calls[0][0].data).not.toHaveProperty('name');

        expect(tx.profile.upsert).toHaveBeenCalledWith({
            where: { userId: 'user-1' },
            create: {
                userId: 'user-1',
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
    });

    it('removes profile photos, tags and the verified-profile badge', async () => {
        const { db, tx } = makeDb();
        mockGetDatabase.mockReturnValue(db);

        await resetUserProfileToInitialState('user-1');

        expect(tx.profilePhoto.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
        expect(tx.userTag.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
        expect(tx.userBadge.deleteMany).toHaveBeenCalledWith({
            where: { userId: 'user-1', badgeKey: 'verified_profile' }
        });
    });

    it('cleans stored photos and invalidates discovery caches after the transaction', async () => {
        const { db } = makeDb();
        mockGetDatabase.mockReturnValue(db);

        await resetUserProfileToInitialState('user-1');

        expect(mockDeleteImagePair).toHaveBeenCalledTimes(2);
        expect(mockDeleteImagePair).toHaveBeenNthCalledWith(1, 'photos/user-1/a.webp', 'photos/user-1/a.blurred.webp');
        expect(mockDeleteImagePair).toHaveBeenNthCalledWith(2, 'photos/user-1/b.webp', 'photos/user-1/b.blurred.webp');
        expect(mockInvalidateCandidate).toHaveBeenCalledWith('user-1');
        expect(mockInvalidatePipelineSetup).toHaveBeenCalledWith('user-1');
        expect(mockInvalidateDiscoveryCounts).toHaveBeenCalledWith('user-1');
        expect(mockInvalidateActivityDiscoveryCache).toHaveBeenCalledWith('user-1');
        expect(mockInvalidateActivityCatalogCache).toHaveBeenCalledWith();
    });

    it('throws a not-found error before mutating when the user does not exist', async () => {
        const { db } = makeDb();
        db.user.findUnique.mockResolvedValue(null);
        mockGetDatabase.mockReturnValue(db);

        await expect(resetUserProfileToInitialState('missing-user')).rejects.toBeInstanceOf(
            AdminProfileResetUserNotFoundError
        );

        expect(db.profilePhoto.findMany).not.toHaveBeenCalled();
        expect(db.$transaction).not.toHaveBeenCalled();
    });
});
