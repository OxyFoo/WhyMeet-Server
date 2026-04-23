import { computeMatchScore, MIN_SCORE_THRESHOLD } from '@/services/scoring';
import type { ScoringCandidate, ScoringContext } from '@/services/scoring';

function baseCtx(overrides: Partial<ScoringContext> = {}): ScoringContext {
    return {
        myIntentions: ['dating'],
        myInterestTagIds: new Set(),
        mySkillTagIds: new Set(),
        myDomainCounts: new Map(),
        myLanguages: ['fr'],
        myLatitude: 48.85,
        myLongitude: 2.35,
        myPreferredPeriod: 'any',
        mySocialVibe: 'balanced',
        maxDistance: 50,
        isRemote: false,
        ...overrides
    };
}

function baseCandidate(overrides: Partial<ScoringCandidate> = {}): ScoringCandidate {
    return {
        intentions: ['dating'],
        interestTagIds: new Set(),
        skillTagIds: new Set(),
        domainCounts: new Map(),
        spokenLanguages: ['fr'],
        latitude: 48.85,
        longitude: 2.35,
        bio: 'nice bio with enough content',
        photoCount: 2,
        verified: true,
        tagCount: 3,
        preferredPeriod: 'any',
        socialVibe: 'balanced',
        reportCount: 0,
        ...overrides
    };
}

describe('scoreInterests — fuzzy matching tiers', () => {
    it('same-type strict overlap scores higher than cross-type strict overlap', () => {
        const sameTypeCtx = baseCtx({
            myInterestTagIds: new Set(['tagA']),
            myDomainCounts: new Map([['sports', 1]])
        });
        const sameTypeCand = baseCandidate({
            interestTagIds: new Set(['tagA']),
            domainCounts: new Map([['sports', 1]])
        });
        const crossCtx = baseCtx({
            myInterestTagIds: new Set(['tagA']),
            myDomainCounts: new Map([['sports', 1]])
        });
        const crossCand = baseCandidate({
            skillTagIds: new Set(['tagA']),
            domainCounts: new Map([['sports', 1]])
        });

        const sameTypeScore = computeMatchScore(sameTypeCtx, sameTypeCand).interests;
        const crossScore = computeMatchScore(crossCtx, crossCand).interests;

        expect(sameTypeScore).toBeGreaterThan(crossScore);
        expect(crossScore).toBeGreaterThan(0);
    });

    it('cross-type strict overlap scores higher than same-domain-only overlap', () => {
        const crossCtx = baseCtx({
            myInterestTagIds: new Set(['tagA']),
            myDomainCounts: new Map([['music', 1]])
        });
        const crossCand = baseCandidate({
            skillTagIds: new Set(['tagA']),
            domainCounts: new Map([['music', 1]])
        });

        // Domain-only: different tag IDs, same domain
        const domainCtx = baseCtx({
            myInterestTagIds: new Set(['tagA']),
            myDomainCounts: new Map([['music', 1]])
        });
        const domainCand = baseCandidate({
            interestTagIds: new Set(['tagB']),
            domainCounts: new Map([['music', 1]])
        });

        const crossScore = computeMatchScore(crossCtx, crossCand).interests;
        const domainScore = computeMatchScore(domainCtx, domainCand).interests;

        expect(crossScore).toBeGreaterThan(domainScore);
        expect(domainScore).toBeGreaterThan(0);
    });

    it('no overlap at all scores zero interests', () => {
        const ctx = baseCtx({
            myInterestTagIds: new Set(['tagA']),
            myDomainCounts: new Map([['music', 1]])
        });
        const cand = baseCandidate({
            interestTagIds: new Set(['tagB']),
            domainCounts: new Map([['sports', 1]])
        });
        expect(computeMatchScore(ctx, cand).interests).toBe(0);
    });

    it('empty tag sets on both sides score zero interests (not NaN)', () => {
        const ctx = baseCtx();
        const cand = baseCandidate();
        const b = computeMatchScore(ctx, cand);
        expect(b.interests).toBe(0);
        expect(b.total).toBeGreaterThanOrEqual(MIN_SCORE_THRESHOLD);
    });

    it('does not double-count strict matches in the domain bonus', () => {
        const ctx = baseCtx({
            myInterestTagIds: new Set(['tagA']),
            myDomainCounts: new Map([['music', 1]])
        });
        // Exact same tag on both profiles → strict same-type match + its domain count.
        const cand = baseCandidate({
            interestTagIds: new Set(['tagA']),
            domainCounts: new Map([['music', 1]])
        });
        // Same tag, no extra domain overlap: score should correspond to a pure
        // strict match, not strict + domain (the residualDomain clamp ensures this).
        const both = computeMatchScore(ctx, cand).interests;

        // Reference: pure strict match isolated
        const pureStrictCtx = baseCtx({ myInterestTagIds: new Set(['tagA']) });
        const pureStrictCand = baseCandidate({ interestTagIds: new Set(['tagA']) });
        const pureStrict = computeMatchScore(pureStrictCtx, pureStrictCand).interests;

        expect(both).toBeCloseTo(pureStrict, 5);
    });
});
