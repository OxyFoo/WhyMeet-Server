import type { Profile, IntentionKey, Gender, PreferredPeriod } from '@whymeet/types';

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
export function mapUserToProfile(user: {
    id: string;
    name: string;
    age: number;
    gender: string;
    avatar: string;
    city: string;
    verified: boolean;
    preferredPeriod?: string;
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
        intentions: string[];
        spokenLanguages: string[];
    } | null;
    tags?: { type: string; tag: { id: string; label: string } }[];
}): Profile {
    return {
        id: user.id,
        name: user.name,
        age: user.age,
        gender: (user.gender || 'male') as Gender,
        avatar: user.avatar,
        city: user.city,
        verified: user.verified,
        preferredPeriod: (user.preferredPeriod ?? 'any') as PreferredPeriod,
        bio: user.profile?.bio ?? '',
        socialVibe: (user.profile?.socialVibe ?? 'chill') as Profile['socialVibe'],
        interests: (user.tags ?? [])
            .filter((t) => t.type === 'interest')
            .map((t) => ({ id: t.tag.id, label: t.tag.label })),
        skills: (user.tags ?? []).filter((t) => t.type === 'skill').map((t) => ({ id: t.tag.id, label: t.tag.label })),
        intentions: (user.profile?.intentions ?? []) as IntentionKey[],
        spokenLanguages: user.profile?.spokenLanguages ?? [],
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
        }
    };
}

/** Prisma include clause to fetch everything needed for mapUserToProfile */
export const profileInclude = {
    profile: true,
    tags: { include: { tag: true } }
} as const;

// ─── MatchCandidate mapping ─────────────────────────────────────────

import type { MatchCandidate } from '@whymeet/types';

type PrismaUserWithProfile = Parameters<typeof mapUserToProfile>[0];

/**
 * Maps a Prisma User (with profile/tags) to a MatchCandidate.
 * @param priorityIntentions — intentions to sort first in the list
 * @param refLatLng — reference user's coordinates for distance calculation
 */
export function mapUserToCandidate(
    user: PrismaUserWithProfile,
    priorityIntentions?: IntentionKey[],
    refLatLng?: { latitude: number | null; longitude: number | null }
): MatchCandidate {
    const userIntentions = (user.profile?.intentions ?? []) as IntentionKey[];
    const sorted = priorityIntentions?.length
        ? [
              ...userIntentions.filter((i) => priorityIntentions.includes(i)),
              ...userIntentions.filter((i) => !priorityIntentions.includes(i))
          ]
        : userIntentions;

    return {
        id: user.id,
        user: {
            id: user.id,
            name: user.name,
            age: user.age,
            gender: (user.gender || 'male') as Gender,
            avatar: user.avatar,
            city: user.city,
            verified: user.verified,
            preferredPeriod: (user.preferredPeriod ?? 'any') as PreferredPeriod
        },
        intentions: sorted,
        bio: user.profile?.bio ?? '',
        interests: (user.tags ?? []).filter((t) => t.type === 'interest').map((t) => t.tag.label),
        skills: (user.tags ?? []).filter((t) => t.type === 'skill').map((t) => t.tag.label),
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
