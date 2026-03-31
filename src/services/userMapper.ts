import type { Profile, IntentionKey } from '@whymeet/types';

/**
 * Maps a Prisma User (with profile/tags) to the shared Profile type.
 */
export function mapUserToProfile(user: {
    id: string;
    name: string;
    age: number;
    avatar: string;
    city: string;
    verified: boolean;
    profile?: {
        bio: string;
        socialVibe: string;
        country: string;
        region: string;
        city: string;
        statConnections: number;
        statMatches: number;
        statVibes: number;
        intentions: string[];
    } | null;
    tags?: { type: string; tag: { id: string; label: string } }[];
}): Profile {
    return {
        id: user.id,
        name: user.name,
        age: user.age,
        avatar: user.avatar,
        city: user.city,
        verified: user.verified,
        bio: user.profile?.bio ?? '',
        socialVibe: (user.profile?.socialVibe ?? 'chill') as Profile['socialVibe'],
        interests: (user.tags ?? [])
            .filter((t) => t.type === 'interest')
            .map((t) => ({ id: t.tag.id, label: t.tag.label })),
        skills: (user.tags ?? []).filter((t) => t.type === 'skill').map((t) => ({ id: t.tag.id, label: t.tag.label })),
        intentions: (user.profile?.intentions ?? []) as IntentionKey[],
        location: {
            country: user.profile?.country ?? '',
            region: user.profile?.region ?? '',
            city: user.profile?.city ?? ''
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
 */
export function mapUserToCandidate(user: PrismaUserWithProfile, priorityIntentions?: IntentionKey[]): MatchCandidate {
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
            avatar: user.avatar,
            city: user.city,
            verified: user.verified
        },
        intentions: sorted,
        bio: user.profile?.bio ?? '',
        tags: (user.tags ?? []).map((t) => t.tag.label),
        distance: '',
        mutualFriends: 0
    };
}

/** Prisma include for candidate queries (same as profile for now) */
export const candidateInclude = profileInclude;
