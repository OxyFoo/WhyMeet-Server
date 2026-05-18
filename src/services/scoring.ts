import {
    getCategoryKeyForIntention,
    getIntention,
    type IntentionFallbackLevel,
    type IntentionMatchSummary,
    type InterestCategoryKey,
    type PreferredPeriod,
    type IntentionKey,
    type IntentionCategoryKey,
    type SocialVibe
} from '@oxyfoo/whymeet-types';
import { normalizeActiveIntentionKeys } from '@/services/intentionKeys';

// Local copy of the ordinal vibe scale (avoids ESM value import in CJS test env)
const VIBE_SCALE: readonly SocialVibe[] = ['reserved', 'calm', 'balanced', 'outgoing', 'very_social'];

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Tag data needed for scoring. We match by lowercased raw label so two users
 * who typed the same word match even when neither is yet linked to a
 * canonical Tag (canonicals are promoted in a separate batch job).
 * `domainCounts` aggregates how many interest+skill tags the user has per
 * canonical InterestCategoryKey domain — lets us reward "same domain"
 * affinities even when exact tags differ ("guitare" vs "piano" → both music).
 * UserTags without a canonical link contribute nothing to `domainCounts`.
 */
export interface ScoringCandidate {
    intentionKeys: IntentionKey[];
    intentionCategoryKeys: IntentionCategoryKey[];
    interestLabels: Set<string>;
    skillLabels: Set<string>;
    domainCounts: Map<InterestCategoryKey, number>;
    spokenLanguages: string[];
    latitude: number | null;
    longitude: number | null;
    bio: string;
    photoCount: number;
    verified: boolean;
    tagCount: number;
    preferredPeriod: PreferredPeriod;
    socialVibe: SocialVibe;
    reportCount: number;
}

export interface ScoringContext {
    myIntentionKeys: IntentionKey[];
    targetCategoryKey?: IntentionCategoryKey;
    targetIntentionKey?: IntentionKey;
    targetIntentionKeys?: IntentionKey[];
    myInterestLabels: Set<string>;
    mySkillLabels: Set<string>;
    myDomainCounts: Map<InterestCategoryKey, number>;
    myLanguages: string[];
    myLatitude: number | null;
    myLongitude: number | null;
    myPreferredPeriod: PreferredPeriod;
    mySocialVibe: SocialVibe;
    maxDistance: number;
    isRemote: boolean;
}

export interface ScoreBreakdown {
    intentionFit: number;
    distance: number;
    interests: number;
    availability: number;
    socialVibe: number;
    profileQuality: number;
    total: number;
}

// ─── Constants ──────────────────────────────────────────────────────

const WEIGHT_INTENTION = 30;
const WEIGHT_DISTANCE = 20;
const WEIGHT_INTERESTS = 15;
const WEIGHT_AVAILABILITY = 10;
const WEIGHT_SOCIAL_VIBE = 5;
const WEIGHT_QUALITY = 20;

// Fuzzy-matching weights for tag overlap:
//   same list (interest↔interest, skill↔skill) → full weight
//   cross list (interest↔skill)                → most of the weight
//   same domain but no exact tag match         → partial weight
const WEIGHT_TAG_SAME_TYPE = 1.0;
const WEIGHT_TAG_CROSS_TYPE = 0.85;
const WEIGHT_TAG_DOMAIN = 0.4;
const WEIGHT_INTENTION_HIERARCHICAL = 0.82;

export const MIN_SCORE_THRESHOLD = 15;

// ─── Haversine ──────────────────────────────────────────────────────

function distanceKm(lat1: number | null, lng1: number | null, lat2: number | null, lng2: number | null): number | null {
    if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null;
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Sub-scores ─────────────────────────────────────────────────────

// Hybrid scoring: blend ratio (relative compatibility) with volume (absolute count).
// This avoids penalising users with many tags who share several with you,
// while still rewarding high overlap when both sides have few items.
// ratio_weight = 0.4, volume_weight = 0.6

function hybridScore(common: number, maxSide: number, cap: number, weight: number): number {
    if (maxSide === 0) return 0;
    const ratio = common / maxSide;
    const volume = Math.min(common / cap, 1);
    return (0.4 * ratio + 0.6 * volume) * weight;
}

function uniqueIntentionKeys(keys: readonly IntentionKey[]): IntentionKey[] {
    return normalizeActiveIntentionKeys(keys);
}

function getRequestedIntentionKeys(ctx: ScoringContext): IntentionKey[] {
    return uniqueIntentionKeys(
        ctx.targetIntentionKeys?.length
            ? ctx.targetIntentionKeys
            : ctx.targetIntentionKey
              ? [ctx.targetIntentionKey]
              : ctx.myIntentionKeys
    );
}

function scoreIntention(ctx: ScoringContext, candidate: ScoringCandidate): number {
    const mine = uniqueIntentionKeys(ctx.myIntentionKeys);
    const theirs = uniqueIntentionKeys(candidate.intentionKeys);
    const theirCategoryKeys = new Set<IntentionCategoryKey>(candidate.intentionCategoryKeys);
    if (mine.length === 0 && theirs.length === 0 && theirCategoryKeys.size === 0) return 0;

    const requested = getRequestedIntentionKeys(ctx);
    const comparison = requested.length > 0 ? requested : mine;
    // A direct hit is either an exact intentionKey match, or one of our requested
    // intentions whose category appears in the candidate's category-global picks.
    const directCommon = comparison.filter(
        (key) => theirs.includes(key) || theirCategoryKeys.has(getCategoryKeyForIntention(key))
    ).length;
    // Hierarchical bonus: count comparison keys whose category appears in theirs
    // (via a leaf intention) but no exact intention match — siblings of selected
    // intention. Already-counted direct hits are excluded.
    const theirCategoriesFromLeaves = new Set(theirs.map((key) => getCategoryKeyForIntention(key)));
    const hierarchicalCommon = comparison.filter((key) => {
        if (theirs.includes(key)) return false;
        const category = getCategoryKeyForIntention(key);
        if (theirCategoryKeys.has(category)) return false; // already counted as direct
        return theirCategoriesFromLeaves.has(category);
    }).length;
    const weightedCommon = directCommon + hierarchicalCommon * WEIGHT_INTENTION_HIERARCHICAL;
    const directScore = hybridScore(weightedCommon, Math.max(comparison.length, theirs.length), 3, WEIGHT_INTENTION);

    const targetCategory =
        ctx.targetCategoryKey ??
        (ctx.targetIntentionKey ? getCategoryKeyForIntention(ctx.targetIntentionKey) : undefined);
    const sameCategory = targetCategory
        ? theirCategoryKeys.has(targetCategory) ||
          theirs.some((key) => getCategoryKeyForIntention(key) === targetCategory)
        : comparison.some((wanted) => {
              const category = getCategoryKeyForIntention(wanted);
              return theirCategoryKeys.has(category) || theirCategoriesFromLeaves.has(category);
          });

    return Math.max(directScore, sameCategory ? WEIGHT_INTENTION * 0.65 : 0);
}

function scoreDistance(ctx: ScoringContext, candidate: ScoringCandidate): number {
    if (ctx.isRemote) {
        // Remote mode: score based on common languages
        const maxLangs = Math.max(ctx.myLanguages.length, candidate.spokenLanguages.length);
        if (maxLangs === 0) return WEIGHT_DISTANCE * 0.5; // neutral
        const common = ctx.myLanguages.filter((l) => candidate.spokenLanguages.includes(l)).length;
        return (common / maxLangs) * WEIGHT_DISTANCE;
    }

    const dist = distanceKm(ctx.myLatitude, ctx.myLongitude, candidate.latitude, candidate.longitude);
    if (dist == null) return WEIGHT_DISTANCE * 0.5; // unknown position → neutral score
    if (ctx.maxDistance <= 0) return 0;
    return Math.max(0, 1 - dist / ctx.maxDistance) * WEIGHT_DISTANCE;
}

function scoreInterests(ctx: ScoringContext, candidate: ScoringCandidate): number {
    const mySize = ctx.myInterestLabels.size + ctx.mySkillLabels.size;
    const theirSize = candidate.interestLabels.size + candidate.skillLabels.size;
    const max = Math.max(mySize, theirSize);
    if (max === 0) return 0;

    // 1. Strict same-type overlap (interest↔interest, skill↔skill)
    let strictSame = 0;
    for (const label of candidate.interestLabels) if (ctx.myInterestLabels.has(label)) strictSame++;
    for (const label of candidate.skillLabels) if (ctx.mySkillLabels.has(label)) strictSame++;

    // 2. Strict cross-type overlap (my interest ↔ their skill, and vice-versa)
    //    Only count each label once per direction to avoid double-counting
    //    when a user has the same tag in both lists.
    let crossSame = 0;
    for (const label of candidate.skillLabels) {
        if (ctx.myInterestLabels.has(label) && !ctx.mySkillLabels.has(label)) crossSame++;
    }
    for (const label of candidate.interestLabels) {
        if (ctx.mySkillLabels.has(label) && !ctx.myInterestLabels.has(label)) crossSame++;
    }

    // 3. Domain affinity = min-overlap of per-domain counts, MINUS the strict
    //    matches already rewarded (they would otherwise be double-counted since
    //    an exact-match tag also contributes to its domain count).
    let domainOverlap = 0;
    for (const [domain, myCount] of ctx.myDomainCounts) {
        const theirCount = candidate.domainCounts.get(domain) ?? 0;
        if (theirCount > 0) domainOverlap += Math.min(myCount, theirCount);
    }
    const residualDomain = Math.max(0, domainOverlap - strictSame - crossSame);

    const rawCommon =
        WEIGHT_TAG_SAME_TYPE * strictSame + WEIGHT_TAG_CROSS_TYPE * crossSame + WEIGHT_TAG_DOMAIN * residualDomain;

    return hybridScore(rawCommon, max, 5, WEIGHT_INTERESTS);
}

function scoreAvailability(mine: PreferredPeriod, theirs: PreferredPeriod): number {
    if (mine === theirs) return WEIGHT_AVAILABILITY; // same period or both "any"
    if (mine === 'any' || theirs === 'any') return WEIGHT_AVAILABILITY * 0.5; // one flexible
    return 0; // different periods
}

function scoreProfileQuality(candidate: ScoringCandidate): number {
    // 5+ unique reports → quality score is 0
    if (candidate.reportCount >= 5) return 0;

    let parts = 0; // out of 10
    if (candidate.bio.length >= 30) parts += 2;
    if (candidate.photoCount > 0) parts += 2;
    if (candidate.verified) parts += 2;
    if (candidate.tagCount >= 3) parts += 2;
    if (candidate.intentionKeys.length >= 1) parts += 1;
    if (candidate.spokenLanguages.length >= 1) parts += 1;
    return (parts / 10) * WEIGHT_QUALITY;
}

function scoreSocialVibe(mine: SocialVibe, theirs: SocialVibe): number {
    const myIdx = VIBE_SCALE.indexOf(mine);
    const theirIdx = VIBE_SCALE.indexOf(theirs);
    if (myIdx === -1 || theirIdx === -1) return WEIGHT_SOCIAL_VIBE * 0.5;
    const dist = Math.abs(myIdx - theirIdx);
    return (1 - dist / (VIBE_SCALE.length - 1)) * WEIGHT_SOCIAL_VIBE;
}

// ─── Main ───────────────────────────────────────────────────────────

export function computeMatchScore(ctx: ScoringContext, candidate: ScoringCandidate): ScoreBreakdown {
    const intentionFit = scoreIntention(ctx, candidate);
    const distance = scoreDistance(ctx, candidate);
    const interests = scoreInterests(ctx, candidate);
    const availability = scoreAvailability(ctx.myPreferredPeriod, candidate.preferredPeriod);
    const socialVibe = scoreSocialVibe(ctx.mySocialVibe, candidate.socialVibe);
    const profileQuality = scoreProfileQuality(candidate);
    const total = Math.min(
        100,
        Math.max(0, intentionFit + distance + interests + availability + socialVibe + profileQuality)
    );

    return { intentionFit, distance, interests, availability, socialVibe, profileQuality, total };
}

export function buildIntentionMatchSummary(
    ctx: ScoringContext,
    candidate: ScoringCandidate,
    breakdown: ScoreBreakdown
): IntentionMatchSummary | undefined {
    const candidateKeys = uniqueIntentionKeys(candidate.intentionKeys);
    const candidateCategoryKeys = new Set<IntentionCategoryKey>(candidate.intentionCategoryKeys);
    if (candidateKeys.length === 0 && candidateCategoryKeys.size === 0) return undefined;

    const requested = getRequestedIntentionKeys(ctx);
    const direct = requested.find(
        (key) => candidateKeys.includes(key) || candidateCategoryKeys.has(getCategoryKeyForIntention(key))
    );
    const candidateCategories = new Set([
        ...candidateKeys.map((key) => getCategoryKeyForIntention(key)),
        ...candidateCategoryKeys
    ]);
    const hierarchyMatch = direct
        ? undefined
        : requested.find((key) => candidateCategories.has(getCategoryKeyForIntention(key)));
    const targetCategory =
        ctx.targetCategoryKey ??
        (ctx.targetIntentionKey ? getCategoryKeyForIntention(ctx.targetIntentionKey) : undefined);
    const sameCategory = targetCategory
        ? candidateKeys.find((key) => getCategoryKeyForIntention(key) === targetCategory)
        : undefined;
    const intentionKey = direct ?? hierarchyMatch ?? sameCategory ?? candidateKeys[0];
    if (!intentionKey) return undefined;
    const intention = getIntention(intentionKey);

    let fallbackLevel: IntentionFallbackLevel = 'none';
    if (!direct && sameCategory) fallbackLevel = 'same_category';
    else if (!direct && hierarchyMatch) fallbackLevel = 'broad_intention';
    else if (!direct) fallbackLevel = intention.broad ? 'broad_intention' : 'related_domains';

    return {
        categoryKey: intention.categoryKey,
        intentionKey: intention.key,
        fallbackLevel,
        scoreParts: {
            intention: Math.round(breakdown.intentionFit),
            tags: Math.round(breakdown.interests),
            distance: Math.round(breakdown.distance),
            trust: Math.round(breakdown.profileQuality),
            vibe: Math.round(breakdown.socialVibe)
        }
    };
}
