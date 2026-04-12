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
        photos: [{ id: 'photo-1', key: 'photos/user-1/abc.webp', description: '', position: 0 }],
        city: 'Paris',
        verified: true,
        preferredPeriod: 'any',
        profile: {
            bio: 'Hello world',
            socialVibe: 'chill',
            country: 'France',
            region: 'Île-de-France',
            city: 'Paris',
            latitude: 48.8566,
            longitude: 2.3522,
            statConnections: 10,
            statMatches: 5,
            statVibes: 42,
            intentions: ['dating', 'friendship'],
            spokenLanguages: ['fr', 'en']
        },
        tags: [
            { type: 'interest', tag: { id: 'tag-1', label: 'Photographie' } },
            { type: 'interest', tag: { id: 'tag-2', label: 'Randonnée' } },
            { type: 'skill', tag: { id: 'tag-3', label: 'JavaScript' } }
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
            gender: 'female',
            photos: [{ id: 'photo-1', key: 'photos/user-1/abc.webp', description: '', position: 0 }],
            city: 'Paris',
            verified: true,
            preferredPeriod: 'any',
            bio: 'Hello world',
            socialVibe: 'chill',
            interests: [
                { id: 'tag-1', label: 'Photographie' },
                { id: 'tag-2', label: 'Randonnée' }
            ],
            skills: [{ id: 'tag-3', label: 'JavaScript' }],
            intentions: ['dating', 'friendship'],
            spokenLanguages: ['fr', 'en'],
            location: {
                country: 'France',
                region: 'Île-de-France',
                city: 'Paris',
                latitude: 48.8566,
                longitude: 2.3522
            },
            stats: { connections: 10, matches: 5, vibes: 42 }
        });
    });

    it('handles null profile gracefully', () => {
        const user = makePrismaUser({ profile: null });
        const profile = mapUserToProfile(user);

        expect(profile.bio).toBe('');
        expect(profile.socialVibe).toBe('chill');
        expect(profile.intentions).toEqual([]);
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
                { type: 'skill', tag: { id: 's1', label: 'Python' } },
                { type: 'interest', tag: { id: 'i1', label: 'Yoga' } },
                { type: 'skill', tag: { id: 's2', label: 'DevOps' } },
                { type: 'interest', tag: { id: 'i2', label: 'Café' } }
            ]
        });
        const profile = mapUserToProfile(user);

        expect(profile.interests).toEqual([
            { id: 'i1', label: 'Yoga' },
            { id: 'i2', label: 'Café' }
        ]);
        expect(profile.skills).toEqual([
            { id: 's1', label: 'Python' },
            { id: 's2', label: 'DevOps' }
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
                preferredPeriod: 'any'
            },
            intentions: ['dating', 'friendship'],
            bio: 'Hello world',
            interests: ['Photographie', 'Randonnée'],
            skills: ['JavaScript'],
            distance: '',
            distanceKm: undefined,
            mutualFriends: 0
        });
    });

    it('sorts priority intentions first', () => {
        const user = makePrismaUser();
        const candidate = mapUserToCandidate(user, ['friendship']);

        expect(candidate.intentions).toEqual(['friendship', 'dating']);
    });

    it('keeps original order when no priority intentions match', () => {
        const user = makePrismaUser();
        const candidate = mapUserToCandidate(user, ['networking']);

        expect(candidate.intentions).toEqual(['dating', 'friendship']);
    });

    it('returns empty intentions when user has no intentions', () => {
        const user = makePrismaUser({
            profile: {
                bio: 'No intentions',
                socialVibe: 'chill',
                country: '',
                region: '',
                city: '',
                statConnections: 0,
                statMatches: 0,
                statVibes: 0,
                intentions: [],
                spokenLanguages: []
            }
        });
        const candidate = mapUserToCandidate(user);

        expect(candidate.intentions).toEqual([]);
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
        expect(candidate.intentions).toEqual([]);
    });
});
