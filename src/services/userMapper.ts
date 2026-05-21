import type {
    Profile,
    ProfilePhoto,
    Gender,
    PreferredPeriod,
    IntentionKey,
    UserBadge,
    BadgeKey
} from '@oxyfoo/whymeet-types';
import { getHostLevel } from '@oxyfoo/whymeet-types';
import { normalizeActiveIntentionCategoryKeys, normalizeActiveIntentionKeys } from '@/services/intentionKeys';
import { selectTopBadges } from '@/services/badgeService';

type DateLike = Date | string | null | undefined;

function toDate(value: DateLike): Date | null {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toIsoString(value: DateLike): string | null {
    return toDate(value)?.toISOString() ?? null;
}

/**
 * Compute age from a birth date. Returns 0 if null.
 */
export function computeAge(birthDate: DateLike): number {
    const date = toDate(birthDate);
    if (!date) return 0;

    const today = new Date();
    let age = today.getFullYear() - date.getFullYear();
    const monthDiff = today.getMonth() - date.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < date.getDate())) {
        age--;
    }
    return Math.max(0, age);
}

/**
 * Convert age boundaries to a birthDate range (inverted: older age = earlier date).
 */
export function ageToBirthDateRange(minAge: number, maxAge: number): { after: Date; before: Date } {
    const today = new Date();
    // Born BEFORE this date → age >= minAge
    const before = new Date(today.getFullYear() - minAge, today.getMonth(), today.getDate() + 1);
    // Born AFTER this date → age <= maxAge
    const after = new Date(today.getFullYear() - maxAge - 1, today.getMonth(), today.getDate());
    return { after, before };
}

/**
 * Haversine distance between two lat/lng points in km.
 */
export function getDistanceKm(
    lat1: number | null | undefined,
    lng1: number | null | undefined,
    lat2: number | null | undefined,
    lng2: number | null | undefined
): number | null {
    if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null;
    const R = 6371; // km
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Compute a lat/lng bounding box for a given center and radius in km.
 * Returns Prisma-compatible filters for profile.latitude and profile.longitude.
 */
export function geoBoundingBox(
    lat: number | null | undefined,
    lng: number | null | undefined,
    radiusKm: number
): { latitude: { gte: number; lte: number }; longitude: { gte: number; lte: number } } | null {
    if (lat == null || lng == null) return null;
    const latDelta = radiusKm / 111;
    const lngDelta = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
    return {
        latitude: { gte: lat - latDelta, lte: lat + latDelta },
        longitude: { gte: lng - lngDelta, lte: lng + lngDelta }
    };
}

/**
 * Format a numeric distance as a human-readable string.
 */
function formatDistance(
    lat1: number | null | undefined,
    lng1: number | null | undefined,
    lat2: number | null | undefined,
    lng2: number | null | undefined
): string {
    const km = getDistanceKm(lat1, lng1, lat2, lng2);
    if (km == null) return '';
    if (km < 1) return '< 1 km';
    return `${Math.round(km)} km`;
}

/**
 * Maps a Prisma User (with profile/tags) to the shared Profile type.
 */
export function mapUserToProfile(
    user: {
        id: string;
        name: string;
        birthDate: DateLike;
        birthDateLastChangedAt?: DateLike;
        gender: string;
        city: string;
        verified: boolean;
        suspended?: boolean;
        banned?: boolean;
        preferredPeriod?: string;
        photos?: { id: string; key: string; keyBlurred: string; description: string; position: number }[];
        profile?: {
            bio: string;
            socialVibe: string;
            country: string;
            region: string;
            city: string;
            latitude: number | null;
            longitude: number | null;
            statConnections: number;
            statMatches: number;
            statVibes: number;
            intentionKeys: string[];
            intentionCategoryKeys?: string[];
            spokenLanguages: string[];
            trustScore: number;
            completedHostedCount: number;
            preferredDiscoveryView?: string;
        } | null;
        tags?: {
            id: string;
            type: string;
            source?: string | null;
            label: string;
            labelLower: string;
            tag: { id: string; label: string; domainKey?: string | null } | null;
        }[];
        badges?: {
            badgeKey: string;
            earned: boolean;
            earnedAt: DateLike;
            progress: number;
            rewardClaimedAt: DateLike;
            rewardPendingAt: DateLike;
            definition: {
                emoji: string;
                category: string;
                displayOrder: number;
                threshold: number | null;
                rewardType: string | null;
                rewardDescription: string | null;
            };
        }[];
    },
    flags?: { isPremium?: boolean; isBoosted?: boolean }
): Profile {
    return {
        id: user.id,
        name: user.name,
        age: computeAge(user.birthDate),
        birthDate: toIsoString(user.birthDate),
        gender: (user.gender || 'male') as Gender,
        photos: mapProfilePhotos(user.photos),
        city: user.city,
        verified: user.verified,
        suspended: user.suspended ?? false,
        banned: user.banned ?? false,
        preferredPeriod: (user.preferredPeriod ?? 'any') as PreferredPeriod,
        isPremium: flags?.isPremium ?? false,
        isBoosted: flags?.isBoosted ?? false,
        badges: mapBadges(user.badges),
        bio: user.profile?.bio ?? '',
        birthDateLastChangedAt: toIsoString(user.birthDateLastChangedAt),
        socialVibe: (user.profile?.socialVibe ?? 'balanced') as Profile['socialVibe'],
        interests: (user.tags ?? [])
            .filter((t) => t.type === 'interest')
            .map((t) => ({ id: t.id, label: t.label, source: t.source ?? null })),
        skills: (user.tags ?? [])
            .filter((t) => t.type === 'skill')
            .map((t) => ({ id: t.id, label: t.label, source: t.source ?? null })),
        intentionKeys: normalizeActiveIntentionKeys(user.profile?.intentionKeys ?? []),
        intentionCategoryKeys: normalizeActiveIntentionCategoryKeys(user.profile?.intentionCategoryKeys ?? []),
        spokenLanguages: user.profile?.spokenLanguages ?? [],
        preferredDiscoveryView: (user.profile?.preferredDiscoveryView ?? 'swipe') as Profile['preferredDiscoveryView'],
        location: {
            country: user.profile?.country ?? '',
            region: user.profile?.region ?? '',
            city: user.profile?.city ?? '',
            latitude: user.profile?.latitude ?? null,
            longitude: user.profile?.longitude ?? null
        },
        stats: {
            connections: user.profile?.statConnections ?? 0,
            matches: user.profile?.statMatches ?? 0,
            vibes: user.profile?.statVibes ?? 0
        },
        hostLevel: getHostLevel(user.profile?.trustScore ?? 0, user.profile?.completedHostedCount ?? 0)
    };
}

function mapBadges(
    badges?: {
        badgeKey: string;
        earned: boolean;
        earnedAt: DateLike;
        progress: number;
        rewardClaimedAt: DateLike;
        rewardPendingAt: DateLike;
        definition: {
            emoji: string;
            category: string;
            displayOrder: number;
            threshold: number | null;
            rewardType: string | null;
            rewardDescription: string | null;
        };
    }[]
): UserBadge[] {
    if (!badges) return [];
    const mapped: UserBadge[] = badges
        .filter((b) => b.earned)
        .map((b) => ({
            key: b.badgeKey as BadgeKey,
            emoji: b.definition.emoji,
            category: b.definition.category as UserBadge['category'],
            displayOrder: b.definition.displayOrder,
            earned: b.earned,
            earnedAt: toIsoString(b.earnedAt),
            progress: b.progress,
            threshold: b.definition.threshold,
            rewardType: b.definition.rewardType as UserBadge['rewardType'],
            rewardDescription: b.definition.rewardDescription,
            rewardClaimedAt: toIsoString(b.rewardClaimedAt),
            rewardPendingAt: toIsoString(b.rewardPendingAt)
        }));
    return selectTopBadges(mapped, 3);
}

/** Prisma include clause to fetch everything needed for mapUserToProfile */
export const profileInclude = {
    profile: true,
    photos: { orderBy: { position: 'asc' as const } },
    tags: { include: { tag: true } },
    badges: { where: { earned: true }, orderBy: { earnedAt: 'asc' as const }, include: { definition: true } }
} as const;

// ─── MatchCandidate mapping ─────────────────────────────────────────

import type { MatchCandidate } from '@oxyfoo/whymeet-types';

type PrismaUserWithProfile = Parameters<typeof mapUserToProfile>[0];
type PhotoKeyMode = 'clear' | 'blurred';

function mapProfilePhotos(
    photos: { id: string; key: string; keyBlurred: string; description: string; position: number }[] | undefined,
    mode: PhotoKeyMode = 'clear'
): ProfilePhoto[] {
    return (photos ?? []).map((photo) => ({
        id: photo.id,
        key: mode === 'blurred' ? photo.keyBlurred : photo.key,
        description: photo.description,
        position: photo.position
    }));
}

/**
 * Maps a Prisma User (with profile/tags) to a MatchCandidate.
 * @param priorityContextKeys — intentions to sort first in the list
 * @param refLatLng — reference user's coordinates for distance calculation
 * @param flags — additional flags (isPremium, isBoosted) derived at runtime
 */
export function mapUserToCandidate(
    user: PrismaUserWithProfile,
    priorityContextKeys?: IntentionKey[],
    refLatLng?: { latitude: number | null; longitude: number | null },
    flags?: { isPremium?: boolean; isBoosted?: boolean; photoKeyMode?: PhotoKeyMode }
): MatchCandidate {
    const userContextKeys = normalizeActiveIntentionKeys(user.profile?.intentionKeys ?? []);
    const sorted = priorityContextKeys?.length
        ? [
              ...userContextKeys.filter((key) => priorityContextKeys.includes(key)),
              ...userContextKeys.filter((key) => !priorityContextKeys.includes(key))
          ]
        : userContextKeys;

    return {
        id: user.id,
        user: {
            id: user.id,
            name: user.name,
            age: computeAge(user.birthDate),
            birthDate: toIsoString(user.birthDate),
            gender: (user.gender || 'male') as Gender,
            photos: mapProfilePhotos(user.photos, flags?.photoKeyMode ?? 'clear'),
            city: user.city,
            verified: user.verified,
            suspended: user.suspended ?? false,
            banned: user.banned ?? false,
            preferredPeriod: (user.preferredPeriod ?? 'any') as PreferredPeriod,
            isPremium: flags?.isPremium ?? false,
            isBoosted: flags?.isBoosted ?? false,
            badges: mapBadges(user.badges)
        },
        intentionKeys: sorted,
        intentionCategoryKeys: normalizeActiveIntentionCategoryKeys(user.profile?.intentionCategoryKeys ?? []),
        bio: user.profile?.bio ?? '',
        interests: (user.tags ?? []).filter((t) => t.type === 'interest').map((t) => t.label),
        skills: (user.tags ?? []).filter((t) => t.type === 'skill').map((t) => t.label),
        distance: formatDistance(
            refLatLng?.latitude,
            refLatLng?.longitude,
            user.profile?.latitude,
            user.profile?.longitude
        ),
        distanceKm:
            getDistanceKm(refLatLng?.latitude, refLatLng?.longitude, user.profile?.latitude, user.profile?.longitude) ??
            undefined,
        mutualFriends: 0
    };
}

/** Prisma include for candidate queries (same as profile for now) */
export const candidateInclude = profileInclude;
