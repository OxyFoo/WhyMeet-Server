import type { IntentionKey, InterestCategoryKey, PreferredPeriod, SocialVibe } from '@oxyfoo/whymeet-types';

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
    intentions: IntentionKey[];
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
    myIntentions: IntentionKey[];
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
    intentions: number;
    distance: number;
    interests: number;
    availability: number;
    socialVibe: number;
    profileQuality: number;
    total: number;
}

// ─── Constants ──────────────────────────────────────────────────────

const WEIGHT_INTENTIONS = 25;
const WEIGHT_DISTANCE = 15;
const WEIGHT_INTERESTS = 25;
const WEIGHT_AVAILABILITY = 5;
const WEIGHT_SOCIAL_VIBE = 10;
const WEIGHT_QUALITY = 20;

// Fuzzy-matching weights for tag overlap:
//   same list (interest↔interest, skill↔skill) → full weight
//   cross list (interest↔skill)                → most of the weight
//   same domain but no exact tag match         → partial weight
const WEIGHT_TAG_SAME_TYPE = 1.0;
const WEIGHT_TAG_CROSS_TYPE = 0.85;
const WEIGHT_TAG_DOMAIN = 0.4;

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

function scoreIntentions(mine: IntentionKey[], theirs: IntentionKey[]): number {
    if (mine.length === 0 && theirs.length === 0) return 0;
    const max = Math.max(mine.length, theirs.length);
    const common = mine.filter((i) => theirs.includes(i)).length;
    return hybridScore(common, max, 3, WEIGHT_INTENTIONS);
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
    if (candidate.intentions.length >= 1) parts += 1;
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
    const intentions = scoreIntentions(ctx.myIntentions, candidate.intentions);
    const distance = scoreDistance(ctx, candidate);
    const interests = scoreInterests(ctx, candidate);
    const availability = scoreAvailability(ctx.myPreferredPeriod, candidate.preferredPeriod);
    const socialVibe = scoreSocialVibe(ctx.mySocialVibe, candidate.socialVibe);
    const profileQuality = scoreProfileQuality(candidate);
    const total = Math.min(
        100,
        Math.max(0, intentions + distance + interests + availability + socialVibe + profileQuality)
    );

    return { intentions, distance, interests, availability, socialVibe, profileQuality, total };
}
