import type { MatchCandidate } from '@oxyfoo/whymeet-types';
import { obfuscateCandidatePreview, obfuscateString } from '@/services/previewObfuscation';

function makeCandidate(): MatchCandidate {
    return {
        id: 'candidate-1',
        user: {
            id: 'candidate-1',
            name: 'Alice Martin',
            age: 31,
            birthDate: '1995-01-01T00:00:00.000Z',
            gender: 'female',
            photos: [{ id: 'photo-1', key: 'photos/u/photo.blurred.webp', description: '', position: 0 }],
            city: 'Paris',
            verified: true,
            suspended: false,
            banned: false,
            preferredPeriod: 'any',
            isPremium: false,
            isBoosted: false,
            badges: []
        },
        intentionKeys: ['meet_simple_first_date'],
        intentionCategoryKeys: [],
        bio: 'Grande bio visible',
        interests: ['Escalade'],
        skills: ['Cuisine'],
        distance: '12 km'
    };
}

describe('preview obfuscation', () => {
    it('preserves string shape while randomizing letters and digits', () => {
        const input = 'Alice 42, Paris!';
        const output = obfuscateString(input);

        expect(output).toHaveLength(input.length);
        expect(output[5]).toBe(' ');
        expect(output[8]).toBe(',');
        expect(output[9]).toBe(' ');
        expect(output[15]).toBe('!');
    });

    it('obfuscates all visible candidate preview text without touching photos', () => {
        const candidate = makeCandidate();
        const preview = obfuscateCandidatePreview(candidate);

        expect(preview.blurred).toBe(true);
        expect(preview.user.name).toHaveLength(candidate.user.name.length);
        expect(preview.user.city).toHaveLength(candidate.user.city.length);
        expect(preview.bio).toHaveLength(candidate.bio.length);
        expect(preview.distance).toHaveLength(candidate.distance.length);
        expect(preview.user.age).toBeGreaterThanOrEqual(18);
        expect(preview.user.photos).toEqual(candidate.user.photos);
    });
});
