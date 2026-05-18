import { normalizeProfileIntentionKeys } from '@/services/intentionProfileEnrichment';

describe('normalizeProfileIntentionKeys', () => {
    it('stores exactly the keys the user picked (no ancestor expansion)', () => {
        expect(normalizeProfileIntentionKeys(['activity_play_video_games'])).toEqual(['activity_play_video_games']);
    });

    it('filters out unknown / deprecated keys', () => {
        expect(normalizeProfileIntentionKeys(['simple_first_meet'])).toEqual([]);
    });

    it('dedupes input', () => {
        expect(normalizeProfileIntentionKeys(['go_out_coffee', 'go_out_coffee', 'go_out_walk'])).toEqual([
            'go_out_coffee',
            'go_out_walk'
        ]);
    });
});
