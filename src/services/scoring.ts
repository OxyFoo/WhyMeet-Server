import type { IntentionKey, PreferredPeriod } from '@whymeet/types';

// ─── Types ──────────────────────────────────────────────────────────

export interface ScoringCandidate {
    intentions: IntentionKey[];
    tagLabels: Set<string>;
    spokenLanguages: string[];
    latitude: number | null;
    longitude: number | null;
    bio: string;
    photoCount: number;
    verified: boolean;
    tagCount: number;
    preferredPeriod: PreferredPeriod;
}

export interface ScoringContext {
    myIntentions: IntentionKey[];
    myTagLabels: Set<string>;
    myLanguages: string[];
    myLatitude: number | null;
    myLongitude: number | null;
    myPreferredPeriod: PreferredPeriod;
    maxDistance: number;
    isRemote: boolean;
}

export interface ScoreBreakdown {
    intentions: number;
    distance: number;
    interests: number;
    availability: number;
    profileQuality: number;
    total: number;
}

// ─── Constants ──────────────────────────────────────────────────────

const WEIGHT_INTENTIONS = 25;
const WEIGHT_DISTANCE = 20;
const WEIGHT_INTERESTS = 25;
const WEIGHT_AVAILABILITY = 10;
const WEIGHT_QUALITY = 20;

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

function scoreIntentions(mine: IntentionKey[], theirs: IntentionKey[]): number {
    if (mine.length === 0 && theirs.length === 0) return 0;
    const max = Math.max(mine.length, theirs.length);
    if (max === 0) return 0;
    const common = mine.filter((i) => theirs.includes(i)).length;
    return (common / max) * WEIGHT_INTENTIONS;
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

function scoreInterests(mine: Set<string>, theirs: Set<string>): number {
    const max = Math.max(mine.size, theirs.size);
    if (max === 0) return 0;
    let common = 0;
    for (const t of theirs) {
        if (mine.has(t)) common++;
    }
    return (common / max) * WEIGHT_INTERESTS;
}

function scoreAvailability(mine: PreferredPeriod, theirs: PreferredPeriod): number {
    if (mine === theirs) return WEIGHT_AVAILABILITY; // same period or both "any"
    if (mine === 'any' || theirs === 'any') return WEIGHT_AVAILABILITY * 0.5; // one flexible
    return 0; // different periods
}

function scoreProfileQuality(candidate: ScoringCandidate): number {
    let parts = 0; // out of 10
    if (candidate.bio.length >= 30) parts += 2;
    if (candidate.photoCount > 0) parts += 2;
    if (candidate.verified) parts += 2;
    if (candidate.tagCount >= 3) parts += 2;
    if (candidate.intentions.length >= 1) parts += 1;
    if (candidate.spokenLanguages.length >= 1) parts += 1;
    return (parts / 10) * WEIGHT_QUALITY;
}

// ─── Main ───────────────────────────────────────────────────────────

export function computeMatchScore(ctx: ScoringContext, candidate: ScoringCandidate): ScoreBreakdown {
    const intentions = scoreIntentions(ctx.myIntentions, candidate.intentions);
    const distance = scoreDistance(ctx, candidate);
    const interests = scoreInterests(ctx.myTagLabels, candidate.tagLabels);
    const availability = scoreAvailability(ctx.myPreferredPeriod, candidate.preferredPeriod);
    const profileQuality = scoreProfileQuality(candidate);
    const total = Math.min(100, Math.max(0, intentions + distance + interests + availability + profileQuality));

    return { intentions, distance, interests, availability, profileQuality, total };
}
