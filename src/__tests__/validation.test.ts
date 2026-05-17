import { validateSearchFilters, validateIntentionSelection, validateProfileData } from '@/config/validation';
import { INTENTION_KEYS, INTENTIONS_BY_KEY, INTENTION_CATEGORY_KEYS } from '@oxyfoo/whymeet-types';

describe('intention validation', () => {
    it('loads intention exports at runtime', () => {
        expect(Array.isArray(INTENTION_KEYS)).toBe(true);
        expect(Array.isArray(INTENTION_CATEGORY_KEYS)).toBe(true);
        expect(INTENTION_KEYS.length).toBeGreaterThan(0);
        expect(INTENTIONS_BY_KEY[INTENTION_KEYS[0]]).toBeDefined();
    });

    it('accepts coherent intention selections', () => {
        expect(
            validateIntentionSelection({
                categoryKey: 'see_if_it_clicks',
                intentionKey: 'meet_simple_first_date',
                tags: ['Café']
            })
        ).toBeNull();
    });

    it('rejects intention selections where category and intention do not match', () => {
        expect(
            validateIntentionSelection({
                categoryKey: 'build_connection',
                intentionKey: 'meet_simple_first_date'
            })
        ).toBe('Invalid field: selection.intentionKey');
    });

    it('rejects deprecated intention keys in selections', () => {
        expect(
            validateIntentionSelection({
                categoryKey: 'see_if_it_clicks',
                intentionKey: 'simple_first_meet'
            })
        ).toBe('Invalid field: selection.intentionKey');
    });

    it('accepts coherent search filters', () => {
        expect(
            validateSearchFilters({
                categoryKey: 'do_something_together',
                intentionKey: 'activity_sports',
                tags: ['Running']
            })
        ).toBeNull();
    });

    it('rejects search filters that mix a category with intentions from another category', () => {
        expect(
            validateSearchFilters({
                categoryKey: 'talk_and_share',
                intentionKeys: ['activity_sports']
            })
        ).toBe('Invalid field: intentionKey');
    });

    it('rejects deprecated intention keys in search filters', () => {
        expect(validateSearchFilters({ intentionKey: 'simple_first_meet' })).toBe('Invalid field: intentionKey');
    });

    it('accepts deprecated profile intention keys so update-profile can sanitize them', () => {
        expect(
            validateProfileData({
                intentionKeys: ['meet_simple_first_date', 'simple_first_meet']
            })
        ).toBeNull();
    });

    it('accepts up to 16 profile intention keys', () => {
        expect(
            validateProfileData({
                intentionKeys: INTENTION_KEYS.slice(0, 16)
            })
        ).toBeNull();
    });

    it('rejects more than 16 profile intention keys', () => {
        expect(
            validateProfileData({
                intentionKeys: INTENTION_KEYS.slice(0, 17)
            })
        ).toBe('Invalid field: intentionKeys');
    });

    it('rejects non-string profile intention keys', () => {
        expect(
            validateProfileData({
                intentionKeys: ['meet_simple_first_date', 42]
            } as Record<string, unknown>)
        ).toBe('Invalid field: intentionKeys');
    });
});
