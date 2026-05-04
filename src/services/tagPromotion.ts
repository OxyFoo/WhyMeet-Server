/**
 * Tag promotion job (batch).
 *
 * Periodically scans `UserTag` rows that are not linked to any canonical `Tag`
 * (`tagId IS NULL`). When ≥ PROMOTE_THRESHOLD distinct users have converged on
 * the same normalized label (case-insensitive, accent-insensitive clustering),
 * we either:
 *   1. Link the cluster to an existing canonical tag if one is semantically
 *      close enough (cosine similarity >= ALIAS_SIM_THRESHOLD via embedding).
 *      A `TagAlias` row is created so future saves resolve directly.
 *   2. Otherwise, create a new canonical `Tag` (with embedding + domainKey)
 *      and link the cluster to it.
 *
 * Clustering strategy (multi-level):
 *   - Level A (deterministic): Group by (type, labelNorm) where labelNorm is
 *     the robust normalized form (NFD, no accents, normalized spacing/hyphens, lowercase).
 *     Catches: JS/javascript/Java Script/java-script → same cluster
 *   - Level B (semantic): Within each Level-A cluster, sub-group by embedding
 *     similarity if uncertainty remains (optional, for future refinement).
 *
 * Form selection (tie-break stable):
 *   - Choose the most-frequent display label (raw `label`) in the cluster
 *   - Tie-break by earliest createdAt, then lexicographically
 *
 * Raw `UserTag.label` values are preserved in either case — only `tagId` is
 * back-filled. This keeps user-facing display identical while unlocking
 * domain-aware scoring.
 */

import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';
import { generateEmbedding, findSimilarTags, ensureTagEmbedding } from '@/services/embedding';
import { resolveDomain } from '@/services/tagDomain';
import { env } from '@/config/env';
import { normalizeTagLabel } from '@/services/tagNormalization';

const PROMOTE_THRESHOLD = 10; // Number of distinct users sharing a normalized label before promotion
const ALIAS_SIM_THRESHOLD = 0.85; // Cosine similarity above which we alias instead of creating a new canonical
const MAX_CLUSTERS_PER_PASS = 50;
const MAX_ALIAS_CANDIDATES_PER_PASS = 200;
const MAX_ALIAS_BACKFILL_PER_PASS = 500;
const MAX_CANONICAL_EMBEDDINGS_PER_PASS = 100;

let intervalId: NodeJS.Timeout | null = null;

/**
 * Calculate milliseconds until the next promotion window (once-daily at TAG_PROMOTION_WINDOW_HOUR_UTC).
 * For example, if TAG_PROMOTION_WINDOW_HOUR_UTC = 2 (02:00 UTC), and now is 23:00 UTC,
 * the next window is 3 hours away. If now is 03:00 UTC, the next window is 23 hours away.
 */
function getMillisecondsToNextWindow(): number {
    const windowHour = env.TAG_PROMOTION_WINDOW_HOUR_UTC;
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    const utcSeconds = now.getUTCSeconds();
    const utcMs = now.getUTCMilliseconds();

    // Calculate seconds elapsed in current UTC hour
    const secondsElapsedThisHour = utcMinutes * 60 + utcSeconds + utcMs / 1000;

    let hoursUntilWindow: number;
    if (utcHour < windowHour) {
        // Window is later today
        hoursUntilWindow = windowHour - utcHour;
    } else {
        // Window is tomorrow
        hoursUntilWindow = 24 - utcHour + windowHour;
    }

    // Convert to milliseconds and subtract elapsed seconds in current hour to align to start of window hour
    const msUntilWindow = hoursUntilWindow * 60 * 60 * 1000 - secondsElapsedThisHour * 1000;
    return Math.max(msUntilWindow, 100); // At least 100ms to avoid spinning
}

/**
 * Schedule the next promotion run respecting the nocturne window.
 * Recursively schedules itself after each run to maintain once-daily cadence.
 */
function scheduleNextRun(): void {
    if (!env.TAG_PROMOTION_ENABLED) {
        logger.debug('[TagPromotion] Disabled via env; not scheduling');
        return;
    }

    const msToNext = getMillisecondsToNextWindow();
    logger.debug(
        `[TagPromotion] Next run scheduled in ${(msToNext / 1000 / 60).toFixed(1)} minutes ` +
            `(window: ${env.TAG_PROMOTION_WINDOW_HOUR_UTC}:00 UTC)`
    );

    intervalId = setTimeout(() => {
        runTagPromotionPass().finally(() => {
            // Schedule the next run for tomorrow's window
            scheduleNextRun();
        });
    }, msToNext);
}

interface ClusterCandidate {
    labelNorm: string;
    type: string;
    userCount: number;
    // Chosen display label (most frequent in cluster, stable tie-break)
    selectedLabel: string;
}

interface AliasCandidate {
    labelNorm: string;
    type: string;
    selectedLabel: string;
}

async function persistAlias(tagId: string, alias: string): Promise<boolean> {
    const db = getDatabase();
    const existing = await db.tagAlias.findFirst({
        where: { alias: { equals: alias, mode: 'insensitive' } },
        select: { id: true }
    });
    if (existing) return false;

    await db.tagAlias.create({ data: { tagId, alias } });
    return true;
}

async function ensureCanonicalEmbeddingsForAliasing(): Promise<void> {
    const db = getDatabase();
    const missing = await db.tag.findMany({
        where: { embedding: { isEmpty: true } },
        select: { id: true, label: true },
        orderBy: { createdAt: 'asc' },
        take: MAX_CANONICAL_EMBEDDINGS_PER_PASS
    });

    for (const tag of missing) {
        await ensureTagEmbedding(tag.id, tag.label);
    }
}

async function backfillAliasesForLinkedUserTags(): Promise<number> {
    const db = getDatabase();
    const rows = await db.userTag.findMany({
        where: { tagId: { not: null } },
        select: {
            label: true,
            tagId: true,
            tag: { select: { label: true } }
        },
        distinct: ['tagId', 'label'],
        orderBy: { createdAt: 'desc' },
        take: MAX_ALIAS_BACKFILL_PER_PASS
    });

    let created = 0;
    for (const row of rows) {
        if (!row.tagId || !row.tag) continue;
        if (row.label.toLowerCase() === row.tag.label.toLowerCase()) continue;
        if (await persistAlias(row.tagId, row.label)) created++;
    }

    if (created > 0) logger.info(`[TagPromotion] Backfilled ${created} alias(es) from already-linked user tags`);
    return created;
}

/**
 * Find clusters of unlinked UserTag rows ready for promotion.
 * Groups by (type, labelNorm) and counts distinct users.
 * Selects the most-frequent display label per cluster.
 */
async function findCandidateClusters(): Promise<ClusterCandidate[]> {
    const db = getDatabase();

    // Distinct-user counts per (type, labelNorm) for unlinked rows.
    const rows = await db.$queryRawUnsafe<Array<{ type: string; labelNorm: string; userCount: bigint }>>(
        `SELECT type, "labelNorm", COUNT(DISTINCT "userId")::bigint as "userCount"
         FROM user_tags
         WHERE "tagId" IS NULL
         GROUP BY type, "labelNorm"
         HAVING COUNT(DISTINCT "userId") >= $1
         ORDER BY COUNT(DISTINCT "userId") DESC
         LIMIT $2`,
        PROMOTE_THRESHOLD,
        MAX_CLUSTERS_PER_PASS
    );

    if (rows.length === 0) return [];

    // For each cluster, find the most-frequent display label (with stable tie-break).
    const labelNorms = rows.map((r) => r.labelNorm);
    const samples = await db.userTag.findMany({
        where: { tagId: null, labelNorm: { in: labelNorms } },
        select: { label: true, labelNorm: true, type: true, createdAt: true },
        orderBy: [{ createdAt: 'asc' }]
    });

    // Group by (type, labelNorm), count label frequencies
    const clusterKey = (type: string, labelNorm: string) => `${type}::${labelNorm}`;
    const labelFreq = new Map<string, Map<string, { count: number; oldestAt: Date }>>();
    const selectedLabelByCluster = new Map<string, string>();

    for (const sample of samples) {
        const key = clusterKey(sample.type, sample.labelNorm);
        if (!labelFreq.has(key)) {
            labelFreq.set(key, new Map());
        }
        const freq = labelFreq.get(key)!;
        if (!freq.has(sample.label)) {
            freq.set(sample.label, { count: 0, oldestAt: sample.createdAt });
        }
        const stat = freq.get(sample.label)!;
        stat.count++;
        // Update oldest timestamp if this one is earlier
        if (sample.createdAt < stat.oldestAt) {
            stat.oldestAt = sample.createdAt;
        }
    }

    // For each cluster, select the most-frequent label (tie-break: oldest createdAt, then lexical)
    for (const row of rows) {
        const key = clusterKey(row.type, row.labelNorm);
        const freq = labelFreq.get(key);
        if (!freq) continue;

        let best: { label: string; count: number; oldestAt: Date } | null = null;
        for (const [label, stat] of freq) {
            if (!best) {
                best = { label, ...stat };
            } else if (stat.count > best.count) {
                // Higher frequency wins
                best = { label, ...stat };
            } else if (stat.count === best.count) {
                // Same frequency: earliest createdAt wins
                if (stat.oldestAt < best.oldestAt) {
                    best = { label, ...stat };
                } else if (stat.oldestAt.getTime() === best.oldestAt.getTime()) {
                    // Same timestamp: lexicographically wins
                    if (label < best.label) {
                        best = { label, ...stat };
                    }
                }
            }
        }

        if (best) {
            selectedLabelByCluster.set(key, best.label);
        }
    }

    return rows.map((r) => {
        const key = clusterKey(r.type, r.labelNorm);
        const selectedLabel = selectedLabelByCluster.get(key) ?? r.labelNorm;
        return {
            labelNorm: r.labelNorm,
            type: r.type,
            userCount: Number(r.userCount),
            selectedLabel
        };
    });
}

async function findAliasCandidates(): Promise<AliasCandidate[]> {
    const db = getDatabase();
    const rows = await db.userTag.findMany({
        where: { tagId: null },
        select: { label: true, labelNorm: true, type: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: MAX_ALIAS_CANDIDATES_PER_PASS * 5
    });

    const candidates = new Map<string, AliasCandidate>();
    for (const row of rows) {
        const key = `${row.type}::${row.labelNorm}`;
        if (candidates.has(key)) continue;
        candidates.set(key, {
            labelNorm: row.labelNorm,
            type: row.type,
            selectedLabel: row.label
        });
        if (candidates.size >= MAX_ALIAS_CANDIDATES_PER_PASS) break;
    }

    return [...candidates.values()];
}

async function aliasUnlinkedCandidatesByEmbedding(): Promise<{
    candidatesFound: number;
    linked: number;
    aliased: number;
    skipped: number;
}> {
    const db = getDatabase();
    const stats = { candidatesFound: 0, linked: 0, aliased: 0, skipped: 0 };
    const candidates = await findAliasCandidates();
    stats.candidatesFound = candidates.length;
    if (candidates.length === 0) return stats;

    await ensureCanonicalEmbeddingsForAliasing();

    const canonicalTags = await db.tag.findMany({ select: { id: true, label: true } });
    const canonicalByNorm = new Map(canonicalTags.map((tag) => [normalizeTagLabel(tag.label), tag]));

    for (const candidate of candidates) {
        const sameNormCanonical = canonicalByNorm.get(candidate.labelNorm);
        if (sameNormCanonical) {
            const aliasCreated =
                candidate.selectedLabel.toLowerCase() !== sameNormCanonical.label.toLowerCase()
                    ? await persistAlias(sameNormCanonical.id, candidate.selectedLabel)
                    : false;
            const updated = await db.userTag.updateMany({
                where: { tagId: null, labelNorm: candidate.labelNorm, type: candidate.type },
                data: { tagId: sameNormCanonical.id }
            });
            if (updated.count > 0) stats[aliasCreated ? 'aliased' : 'linked']++;
            continue;
        }

        const embedding = await generateEmbedding(candidate.selectedLabel);
        if (!embedding) {
            stats.skipped++;
            logger.warn('[TagPromotion] Stopping alias pass — embeddings unavailable');
            break;
        }

        const similar = await findSimilarTags(embedding, 1, ALIAS_SIM_THRESHOLD);
        const canonical = similar[0];
        if (!canonical) continue;

        if (candidate.selectedLabel.toLowerCase() !== canonical.label.toLowerCase()) {
            await persistAlias(canonical.id, candidate.selectedLabel);
        }
        const updated = await db.userTag.updateMany({
            where: { tagId: null, labelNorm: candidate.labelNorm, type: candidate.type },
            data: { tagId: canonical.id }
        });
        if (updated.count > 0) stats.aliased++;
        logger.info(
            `[TagPromotion] Semantically aliased unlinked label "${candidate.selectedLabel}" (${candidate.type}) → "${canonical.label}" ` +
                `(sim=${canonical.similarity.toFixed(3)}, linked ${updated.count} rows)`
        );
    }

    return stats;
}

/**
 * Promote a single cluster: link/alias to nearest canonical or create a new one,
 * then link all UserTag rows of the cluster.
 * Returns 'linked' | 'aliased' | 'created' | 'skipped' for telemetry.
 */
async function promoteCluster(cluster: ClusterCandidate): Promise<'linked' | 'aliased' | 'created' | 'skipped'> {
    const db = getDatabase();
    const { labelNorm, type, selectedLabel } = cluster;

    const sameNormCanonical = (await db.tag.findMany({ select: { id: true, label: true } })).find(
        (tag) => normalizeTagLabel(tag.label) === labelNorm
    );
    if (sameNormCanonical) {
        let outcome: 'linked' | 'aliased' = 'linked';
        if (selectedLabel.toLowerCase() !== sameNormCanonical.label.toLowerCase()) {
            const existingAlias = await db.tagAlias.findFirst({
                where: { alias: { equals: selectedLabel, mode: 'insensitive' } },
                select: { id: true }
            });
            if (!existingAlias) {
                await db.tagAlias.create({ data: { tagId: sameNormCanonical.id, alias: selectedLabel } });
            }
            outcome = 'aliased';
        }
        const updated = await db.userTag.updateMany({
            where: { tagId: null, labelNorm, type },
            data: { tagId: sameNormCanonical.id }
        });
        logger.info(
            `[TagPromotion] ${outcome === 'aliased' ? 'Aliased' : 'Linked'} normalized cluster ` +
                `(labelNorm="${labelNorm}", type="${type}", form="${selectedLabel}") → canonical "${sameNormCanonical.label}" ` +
                `(linked ${updated.count} rows)`
        );
        return outcome;
    }

    // Embedding may be unavailable (no OPENAI_API_KEY) — skip gracefully.
    const embedding = await generateEmbedding(selectedLabel);
    if (!embedding) {
        logger.warn(
            `[TagPromotion] Skipping cluster "${selectedLabel}" (${type}, labelNorm="${labelNorm}") — no embedding available`
        );
        return 'skipped';
    }

    // 1. Try to alias to an existing canonical.
    const similar = await findSimilarTags(embedding, 1, ALIAS_SIM_THRESHOLD);
    if (similar.length > 0) {
        const canonical = similar[0];
        if (normalizeTagLabel(canonical.label) === labelNorm) {
            const updated = await db.userTag.updateMany({
                where: { tagId: null, labelNorm, type },
                data: { tagId: canonical.id }
            });
            logger.info(
                `[TagPromotion] Linked cluster (labelNorm="${labelNorm}", type="${type}", form="${selectedLabel}") → canonical "${canonical.label}" ` +
                    `(sim=${canonical.similarity.toFixed(3)}, linked ${updated.count} rows)`
            );
            return 'linked';
        }

        // Create alias if not already present (case-insensitive on alias).
        const existingAlias = await db.tagAlias.findFirst({
            where: { alias: { equals: selectedLabel, mode: 'insensitive' } },
            select: { id: true }
        });
        if (!existingAlias) {
            await db.tagAlias.create({ data: { tagId: canonical.id, alias: selectedLabel } });
        }
        const updated = await db.userTag.updateMany({
            where: { tagId: null, labelNorm, type },
            data: { tagId: canonical.id }
        });
        logger.info(
            `[TagPromotion] Aliased cluster (labelNorm="${labelNorm}", type="${type}", form="${selectedLabel}") → canonical "${canonical.label}" ` +
                `(sim=${canonical.similarity.toFixed(3)}, linked ${updated.count} rows)`
        );
        return 'aliased';
    }

    // 2. Create a new canonical tag.
    const domainKey = await resolveDomain(embedding);
    const created = await db.tag.create({
        data: { label: selectedLabel, embedding, domainKey }
    });
    const updated = await db.userTag.updateMany({
        where: { tagId: null, labelNorm, type },
        data: { tagId: created.id }
    });
    logger.info(
        `[TagPromotion] Created canonical cluster (labelNorm="${labelNorm}", type="${type}") → new tag "${selectedLabel}" ` +
            `(domain=${domainKey ?? 'none'}, linked ${updated.count} rows)`
    );
    return 'created';
}

/**
 * Run a single promotion pass. Safe to call standalone (e.g. from a script).
 */
export async function runTagPromotionPass(): Promise<{
    candidatesFound: number;
    linked: number;
    aliased: number;
    created: number;
    skipped: number;
    failed: number;
}> {
    const stats = { candidatesFound: 0, linked: 0, aliased: 0, created: 0, skipped: 0, failed: 0 };
    try {
        stats.aliased += await backfillAliasesForLinkedUserTags();

        const clusters = await findCandidateClusters();
        stats.candidatesFound = clusters.length;
        if (clusters.length === 0) {
            logger.debug('[TagPromotion] No clusters ready for promotion');
        } else {
            logger.info(
                `[TagPromotion] Found ${clusters.length} cluster(s) ready for promotion (threshold=${PROMOTE_THRESHOLD})`
            );
            for (const cluster of clusters) {
                try {
                    const outcome = await promoteCluster(cluster);
                    stats[outcome] += 1;
                } catch (error) {
                    logger.error(
                        `[TagPromotion] Failed to promote cluster (labelNorm="${cluster.labelNorm}", type="${cluster.type}")`,
                        error
                    );
                    stats.failed += 1;
                }
            }
        }

        const aliasStats = await aliasUnlinkedCandidatesByEmbedding();
        stats.linked += aliasStats.linked;
        stats.aliased += aliasStats.aliased;
        stats.skipped += aliasStats.skipped;

        logger.info(
            `[TagPromotion] Pass done — linked=${stats.linked}, aliased=${stats.aliased}, created=${stats.created}, skipped=${stats.skipped}, failed=${stats.failed}`
        );
    } catch (error) {
        logger.error('[TagPromotion] Pass failed', error);
        stats.failed += 1;
    }
    return stats;
}

/**
 * Start the periodic tag promotion scheduler respecting the nocturne window.
 * Respects TAG_PROMOTION_ENABLED and TAG_PROMOTION_WINDOW_HOUR_UTC env vars.
 * Schedules itself recursively to maintain once-daily cadence.
 */
export function startTagPromotionScheduler(): void {
    if (!env.TAG_PROMOTION_ENABLED) {
        logger.info('[TagPromotion] Scheduler disabled via TAG_PROMOTION_ENABLED=false');
        return;
    }
    if (intervalId) {
        logger.warn('[TagPromotion] Scheduler already running');
        return;
    }
    logger.info(
        `[TagPromotion] Scheduler starting (window: ${env.TAG_PROMOTION_WINDOW_HOUR_UTC}:00 UTC, ` +
            `threshold: ${PROMOTE_THRESHOLD} users)`
    );
    scheduleNextRun();
}

export function stopTagPromotionScheduler(): void {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
}
