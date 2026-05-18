import { isProfileComplete, PROFILE_MIN_TAGS } from '@/services/profileCompletion';

function makeLoadedUser(overrides: Record<string, unknown> = {}) {
    return {
        photos: [{ id: 'photo-1' }],
        gender: 'female',
        birthDate: new Date('2000-01-01'),
        profile: {
            bio: 'Une bio assez longue',
            intentionKeys: ['meet_simple_first_date'],
            socialVibe: 'balanced',
            spokenLanguages: ['fr'],
            latitude: 48.8566,
            longitude: 2.3522
        },
        tags: [
            ...Array.from({ length: PROFILE_MIN_TAGS }, (_, index) => ({
                type: 'interest',
                id: `interest-${index}`
            })),
            ...Array.from({ length: PROFILE_MIN_TAGS }, (_, index) => ({
                type: 'skill',
                id: `skill-${index}`
            }))
        ],
        ...overrides
    };
}

describe('isProfileComplete', () => {
    it('requires the same profile fields as the mobile completion checklist', () => {
        expect(isProfileComplete(makeLoadedUser() as never)).toBe(true);

        expect(isProfileComplete(makeLoadedUser({ tags: [] }) as never)).toBe(false);
        expect(
            isProfileComplete(
                makeLoadedUser({
                    profile: {
                        bio: 'Une bio assez longue',
                        intentionKeys: ['meet_simple_first_date'],
                        socialVibe: 'balanced',
                        spokenLanguages: ['fr'],
                        latitude: 48.8566,
                        longitude: null
                    }
                }) as never
            )
        ).toBe(false);
        expect(
            isProfileComplete(
                makeLoadedUser({
                    profile: {
                        bio: 'Une bio assez longue',
                        intentionKeys: ['meet_simple_first_date'],
                        socialVibe: 'balanced',
                        spokenLanguages: [],
                        latitude: 48.8566,
                        longitude: 2.3522
                    }
                }) as never
            )
        ).toBe(false);
        expect(
            isProfileComplete(
                makeLoadedUser({
                    profile: {
                        bio: 'Une bio assez longue',
                        intentionKeys: ['meet_simple_first_date'],
                        socialVibe: 'chill',
                        spokenLanguages: ['fr'],
                        latitude: 48.8566,
                        longitude: 2.3522
                    }
                }) as never
            )
        ).toBe(false);

        // intentionCategoryKeys sans intentionKeys doit aussi être considéré complet
        expect(
            isProfileComplete(
                makeLoadedUser({
                    profile: {
                        bio: 'Une bio assez longue',
                        intentionKeys: [],
                        intentionCategoryKeys: ['meet'],
                        socialVibe: 'balanced',
                        spokenLanguages: ['fr'],
                        latitude: 48.8566,
                        longitude: 2.3522
                    }
                }) as never
            )
        ).toBe(true);

        // ni intentionKeys ni intentionCategoryKeys → incomplet
        expect(
            isProfileComplete(
                makeLoadedUser({
                    profile: {
                        bio: 'Une bio assez longue',
                        intentionKeys: [],
                        intentionCategoryKeys: [],
                        socialVibe: 'balanced',
                        spokenLanguages: ['fr'],
                        latitude: 48.8566,
                        longitude: 2.3522
                    }
                }) as never
            )
        ).toBe(false);
    });
});
