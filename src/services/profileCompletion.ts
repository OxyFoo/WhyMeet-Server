import { getDatabase } from '@/services/database';
import { profileInclude } from '@/services/userMapper';

/**
 * Minimum number of tags required in each tag bucket (interests, skills) for
 * a profile to be considered complete. Must stay aligned with the client-side
 * value in `WhyMeet/src/features/profile/utils/computeCompletion.ts`.
 */
export const PROFILE_MIN_TAGS = 5;
export const PROFILE_MIN_BIO_LENGTH = 10;

type LoadedUser = NonNullable<Awaited<ReturnType<ReturnType<typeof getDatabase>['user']['findUnique']>>> & {
    profile: NonNullable<unknown> | null;
    photos: { id: string }[];
    tags: { type: string }[];
};

/** Returns `true` when every completion check passes. */
export function isProfileComplete(user: LoadedUser): boolean {
    const profile = (user as unknown as { profile: Record<string, unknown> | null }).profile;
    const interests = (user.tags ?? []).filter((t) => t.type === 'interest').length;
    const skills = (user.tags ?? []).filter((t) => t.type === 'skill').length;
    return (
        (user.photos ?? []).length > 0 &&
        ((profile?.bio as string | null | undefined) ?? '').trim().length >= PROFILE_MIN_BIO_LENGTH &&
        Array.isArray(profile?.intentions) &&
        (profile?.intentions as unknown[]).length > 0 &&
        interests >= PROFILE_MIN_TAGS &&
        skills >= PROFILE_MIN_TAGS &&
        ((profile?.socialVibe as string | null | undefined) ?? '') !== '' &&
        Array.isArray(profile?.spokenLanguages) &&
        (profile?.spokenLanguages as unknown[]).length > 0 &&
        profile?.latitude != null &&
        (user as unknown as { birthDate: Date | null }).birthDate != null
    );
}

/** Loads the user with the relations needed by `isProfileComplete`. */
export async function loadUserForCompletion(userId: string) {
    const db = getDatabase();
    return db.user.findUnique({ where: { id: userId }, include: profileInclude });
}
