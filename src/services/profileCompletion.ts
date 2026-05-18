import { getDatabase } from '@/services/database';
import { profileInclude } from '@/services/userMapper';
import { SOCIAL_VIBES } from '@oxyfoo/whymeet-types';

export const PROFILE_MIN_BIO_LENGTH = 10;
export const PROFILE_MIN_TAGS = 5;

type LoadedUser = NonNullable<Awaited<ReturnType<ReturnType<typeof getDatabase>['user']['findUnique']>>> & {
    profile: NonNullable<unknown> | null;
    photos: { id: string }[];
    tags: { type: string }[];
};

function countTags(user: LoadedUser, type: 'interest' | 'skill'): number {
    return (user.tags ?? []).filter((tag) => tag.type === type).length;
}

/** Returns `true` when every completion check passes. */
export function isProfileComplete(user: LoadedUser): boolean {
    const profile = (user as unknown as { profile: Record<string, unknown> | null }).profile;
    return (
        (user.photos ?? []).length > 0 &&
        ((user as unknown as { gender: string | null }).gender ?? '') !== '' &&
        ((profile?.bio as string | null | undefined) ?? '').trim().length >= PROFILE_MIN_BIO_LENGTH &&
        ((Array.isArray(profile?.intentionKeys) && (profile?.intentionKeys as unknown[]).length > 0) ||
            (Array.isArray(profile?.intentionCategoryKeys) &&
                (profile?.intentionCategoryKeys as unknown[]).length > 0)) &&
        countTags(user, 'interest') >= PROFILE_MIN_TAGS &&
        countTags(user, 'skill') >= PROFILE_MIN_TAGS &&
        typeof profile?.socialVibe === 'string' &&
        (SOCIAL_VIBES as readonly string[]).includes(profile.socialVibe) &&
        Array.isArray(profile?.spokenLanguages) &&
        (profile?.spokenLanguages as unknown[]).length > 0 &&
        profile?.latitude != null &&
        profile?.longitude != null &&
        (user as unknown as { birthDate: Date | null }).birthDate != null
    );
}

/** Loads the user with the relations needed by `isProfileComplete`. */
export async function loadUserForCompletion(userId: string) {
    const db = getDatabase();
    return db.user.findUnique({ where: { id: userId }, include: profileInclude });
}
