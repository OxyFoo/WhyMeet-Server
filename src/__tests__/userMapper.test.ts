import { mapUserToProfile, mapUserToCandidate, computeAge } from '@/services/userMapper';

// ─── Fixtures ───────────────────────────────────────────────────────

function makePrismaUser(overrides: Record<string, unknown> = {}) {
    return { ...baseUser(), ...overrides };
}

const BIRTH_DATE = new Date('2000-01-15');

function baseUser() {
    return {
        id: 'user-1',
        name: 'Alice',
        birthDate: BIRTH_DATE,
        gender: 'female',
        photos: [
            {
                id: 'photo-1',
                key: 'photos/user-1/abc.webp',
                keyBlurred: 'photos/user-1/abc.blurred.webp',
                description: '',
                position: 0
            }
        ],
        city: 'Paris',
        verified: true,
        preferredPeriod: 'any',
        profile: {
            bio: 'Hello world',
            socialVibe: 'balanced',
            country: 'France',
            region: 'Île-de-France',
            city: 'Paris',
            latitude: 48.8566,
            longitude: 2.3522,
            statConnections: 10,
            statMatches: 5,
            statVibes: 42,
            intentionKeys: ['meet_simple_first_date', 'meet_make_acquaintance'],
            spokenLanguages: ['fr', 'en'],
            trustScore: 0,
            completedHostedCount: 0
        },
        tags: [
            {
                id: 'ut-1',
                type: 'interest',
                label: 'Photographie',
                labelLower: 'photographie',
                tag: { id: 'tag-1', label: 'Photographie' }
            },
            {
                id: 'ut-2',
                type: 'interest',
                label: 'Randonnée',
                labelLower: 'randonnée',
                tag: { id: 'tag-2', label: 'Randonnée' }
            },
            {
                id: 'ut-3',
                type: 'skill',
                label: 'JavaScript',
                labelLower: 'javascript',
                tag: { id: 'tag-3', label: 'JavaScript' }
            }
        ]
    };
}

// ─── mapUserToProfile ───────────────────────────────────────────────

describe('mapUserToProfile', () => {
    it('maps a full Prisma user to a Profile', () => {
        const user = makePrismaUser();
        const profile = mapUserToProfile(user);

        expect(profile).toEqual({
            id: 'user-1',
            name: 'Alice',
            age: computeAge(BIRTH_DATE),
            birthDate: BIRTH_DATE.toISOString(),
            birthDateLastChangedAt: null,
            gender: 'female',
            photos: [{ id: 'photo-1', key: 'photos/user-1/abc.webp', description: '', position: 0 }],
            city: 'Paris',
            verified: true,
            suspended: false,
            banned: false,
            preferredPeriod: 'any',
            preferredDiscoveryView: 'advanced',
            isPremium: false,
            isBoosted: false,
            bio: 'Hello world',
            socialVibe: 'balanced',
            interests: [
                { id: 'ut-1', label: 'Photographie', source: null },
                { id: 'ut-2', label: 'Randonnée', source: null }
            ],
            skills: [{ id: 'ut-3', label: 'JavaScript', source: null }],
            intentionKeys: ['meet_simple_first_date', 'meet_make_acquaintance'],
            intentionCategoryKeys: [],
            spokenLanguages: ['fr', 'en'],
            location: {
                country: 'France',
                region: 'Île-de-France',
                city: 'Paris',
                latitude: 48.8566,
                longitude: 2.3522
            },
            stats: { connections: 10, matches: 5, vibes: 42 },
            badges: [],
            hostLevel: null
        });
    });

    it('handles null profile gracefully', () => {
        const user = makePrismaUser({ profile: null });
        const profile = mapUserToProfile(user);

        expect(profile.bio).toBe('');
        expect(profile.socialVibe).toBe('balanced');
        expect(profile.intentionKeys).toEqual([]);
        expect(profile.location).toEqual({ country: '', region: '', city: '', latitude: null, longitude: null });
        expect(profile.stats).toEqual({ connections: 0, matches: 0, vibes: 0 });
    });

    it('handles undefined tags gracefully', () => {
        const user = makePrismaUser({ tags: undefined });
        const profile = mapUserToProfile(user);

        expect(profile.interests).toEqual([]);
        expect(profile.skills).toEqual([]);
    });

    it('separates interests from skills correctly', () => {
        const user = makePrismaUser({
            tags: [
                {
                    id: 'us-1',
                    type: 'skill',
                    label: 'Python',
                    labelLower: 'python',
                    tag: { id: 's1', label: 'Python' }
                },
                {
                    id: 'ui-1',
                    type: 'interest',
                    label: 'Yoga',
                    labelLower: 'yoga',
                    tag: { id: 'i1', label: 'Yoga' }
                },
                {
                    id: 'us-2',
                    type: 'skill',
                    label: 'DevOps',
                    labelLower: 'devops',
                    tag: { id: 's2', label: 'DevOps' }
                },
                {
                    id: 'ui-2',
                    type: 'interest',
                    label: 'Café',
                    labelLower: 'café',
                    tag: { id: 'i2', label: 'Café' }
                }
            ]
        });
        const profile = mapUserToProfile(user);

        expect(profile.interests).toEqual([
            { id: 'ui-1', label: 'Yoga', source: null },
            { id: 'ui-2', label: 'Café', source: null }
        ]);
        expect(profile.skills).toEqual([
            { id: 'us-1', label: 'Python', source: null },
            { id: 'us-2', label: 'DevOps', source: null }
        ]);
    });
});

// ─── mapUserToCandidate ─────────────────────────────────────────────

describe('mapUserToCandidate', () => {
    it('maps to MatchCandidate with correct shape', () => {
        const user = makePrismaUser();
        const candidate = mapUserToCandidate(user);

        expect(candidate).toEqual({
            id: 'user-1',
            user: {
                id: 'user-1',
                name: 'Alice',
                age: computeAge(BIRTH_DATE),
                birthDate: BIRTH_DATE.toISOString(),
                gender: 'female',
                photos: [{ id: 'photo-1', key: 'photos/user-1/abc.webp', description: '', position: 0 }],
                city: 'Paris',
                verified: true,
                suspended: false,
                banned: false,
                preferredPeriod: 'any',
                isPremium: false,
                isBoosted: false,
                badges: []
            },
            intentionKeys: ['meet_simple_first_date', 'meet_make_acquaintance'],
            intentionCategoryKeys: [],
            bio: 'Hello world',
            interests: ['Photographie', 'Randonnée'],
            skills: ['JavaScript'],
            distance: '',
            distanceKm: undefined,
            mutualFriends: 0
        });
    });

    it('maps to MatchCandidate with blurred photo keys when requested', () => {
        const user = makePrismaUser();
        const candidate = mapUserToCandidate(user, undefined, undefined, { photoKeyMode: 'blurred' });

        expect(candidate.user.photos).toEqual([
            { id: 'photo-1', key: 'photos/user-1/abc.blurred.webp', description: '', position: 0 }
        ]);
    });

    it('sorts priority intentions first', () => {
        const user = makePrismaUser();
        const candidate = mapUserToCandidate(user, ['meet_make_acquaintance']);

        expect(candidate.intentionKeys).toEqual(['meet_make_acquaintance', 'meet_simple_first_date']);
    });

    it('keeps original order when no priority intentions match', () => {
        const user = makePrismaUser();
        const candidate = mapUserToCandidate(user, ['build_mentoring']);

        expect(candidate.intentionKeys).toEqual(['meet_simple_first_date', 'meet_make_acquaintance']);
    });

    it('returns empty intentions when user has no intentions', () => {
        const user = makePrismaUser({
            profile: {
                bio: 'No contexts',
                socialVibe: 'balanced',
                country: '',
                region: '',
                city: '',
                latitude: null,
                longitude: null,
                statConnections: 0,
                statMatches: 0,
                statVibes: 0,
                intentionKeys: [],
                spokenLanguages: []
            }
        });
        const candidate = mapUserToCandidate(user);

        expect(candidate.intentionKeys).toEqual([]);
    });

    it('splits tag labels into interests and skills', () => {
        const user = makePrismaUser();
        const candidate = mapUserToCandidate(user);

        expect(candidate.interests).toContain('Photographie');
        expect(candidate.skills).toContain('JavaScript');
    });

    it('handles null profile', () => {
        const user = makePrismaUser({ profile: null });
        const candidate = mapUserToCandidate(user);

        expect(candidate.bio).toBe('');
        expect(candidate.intentionKeys).toEqual([]);
    });

    it('maps earned badges with dates deserialized from cache', () => {
        const earnedAt = '2026-05-07T19:49:00.000Z';
        const rewardClaimedAt = '2026-05-07T19:50:00.000Z';
        const user = makePrismaUser({
            badges: [
                {
                    badgeKey: 'verified_profile',
                    earned: true,
                    earnedAt,
                    progress: 1,
                    rewardClaimedAt,
                    definition: {
                        emoji: '✓',
                        displayOrder: 1,
                        threshold: 1,
                        rewardType: null,
                        rewardDescription: null
                    }
                }
            ]
        });

        const candidate = mapUserToCandidate(user);

        expect(candidate.user.badges).toEqual([
            expect.objectContaining({
                key: 'verified_profile',
                earnedAt,
                rewardClaimedAt
            })
        ]);
    });
});
