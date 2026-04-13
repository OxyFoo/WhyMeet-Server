import type { MatchCandidate } from '@whymeet/types';

/**
 * Interleave candidates using 60/40 boost distribution.
 *
 * Splits candidates into boosted and normal pools (each already sorted by score),
 * then fills each slot with a probabilistic 60% chance from boosted pool, 40% from normal.
 * If one pool is exhausted, picks from the other.
 *
 * This guarantees heterogeneous results — you won't see ONLY boosted profiles.
 */
export function interleaveByBoost(
    candidates: MatchCandidate[],
    boostedIds: Set<string>,
    boostRatio: number = 0.6
): MatchCandidate[] {
    const boosted: MatchCandidate[] = [];
    const normal: MatchCandidate[] = [];

    for (const c of candidates) {
        if (boostedIds.has(c.id)) {
            boosted.push(c);
        } else {
            normal.push(c);
        }
    }

    // If one pool is empty, return the other as-is (already sorted by score)
    if (boosted.length === 0) return normal;
    if (normal.length === 0) return boosted;

    const result: MatchCandidate[] = [];
    let bi = 0;
    let ni = 0;

    while (bi < boosted.length || ni < normal.length) {
        if (bi >= boosted.length) {
            result.push(normal[ni++]);
        } else if (ni >= normal.length) {
            result.push(boosted[bi++]);
        } else if (Math.random() < boostRatio) {
            result.push(boosted[bi++]);
        } else {
            result.push(normal[ni++]);
        }
    }

    return result;
}
