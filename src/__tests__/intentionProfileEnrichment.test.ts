import { expandSelectedIntentionKeys } from '@/services/intentionProfileEnrichment';

describe('intention profile enrichment', () => {
    it('adds ancestor contexts for a selected leaf', () => {
        expect(expandSelectedIntentionKeys(['activity_play_video_games'])).toEqual([
            'activity_play',
            'activity_play_video_games'
        ]);
    });

    it('ignores deprecated keys instead of normalizing them', () => {
        expect(expandSelectedIntentionKeys(['simple_first_meet'])).toEqual([]);
    });
});
