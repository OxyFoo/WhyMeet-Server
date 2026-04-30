/**
 * Tag promotion job.
 *
 * Periodically scans `UserTag` rows that are not linked to any canonical `Tag`
 * (`tagId IS NULL`). When several distinct users have converged on the same
 * raw label (case-insensitive cluster on `labelLower`, size >= PROMOTE_THRESHOLD),
 * we either:
 *   1. Link the cluster to an existing canonical tag if one is semantically
 *      close enough (cosine similarity >= ALIAS_SIM_THRESHOLD via embedding).
 *      A `TagAlias` row is created so future saves resolve directly.
 *   2. Otherwise, create a new canonical `Tag` (with embedding + domainKey)
 *      and link the cluster to it.
 *
 * Raw `UserTag.label` values are preserved in either case — only `tagId` is
 * back-filled. This keeps user-facing display identical while unlocking
 * domain-aware scoring.
 */

import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';
import { generateEmbedding, findSimilarTags } from '@/services/embedding';
import { resolveDomain } from '@/services/tagDomain';

const PROMOTE_THRESHOLD = 5; // Number of distinct users sharing a raw label before promotion
const ALIAS_SIM_THRESHOLD = 0.85; // Cosine similarity above which we alias instead of creating a new canonical
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CLUSTERS_PER_PASS = 50;

let intervalId: NodeJS.Timeout | null = null;

interface ClusterCandidate {
    labelLower: string;
    label: string; // representative display label (first occurrence)
    type: string;
    userCount: number;
}

/**
 * Find clusters of unlinked UserTag rows ready for promotion.
 * Groups by (type, labelLower) and counts distinct users.
 */
async function findCandidateClusters(): Promise<ClusterCandidate[]> {
    const db = getDatabase();

    // Distinct-user counts per (type, labelLower) for unlinked rows.
    const rows = await db.$queryRawUnsafe<Array<{ type: string; labelLower: string; userCount: bigint }>>(
        `SELECT type, "labelLower", COUNT(DISTINCT "userId")::bigint as "userCount"
         FROM user_tags
         WHERE "tagId" IS NULL
         GROUP BY type, "labelLower"
         HAVING COUNT(DISTINCT "userId") >= $1
         ORDER BY COUNT(DISTINCT "userId") DESC
         LIMIT $2`,
        PROMOTE_THRESHOLD,
        MAX_CLUSTERS_PER_PASS
    );

    if (rows.length === 0) return [];

    // Resolve a representative display label per cluster (first occurrence).
    const labelLowers = rows.map((r) => r.labelLower);
    const samples = await db.userTag.findMany({
        where: { tagId: null, labelLower: { in: labelLowers } },
        select: { label: true, labelLower: true, type: true },
        distinct: ['type', 'labelLower']
    });
    const displayKey = (type: string, labelLower: string): string => `${type}::${labelLower}`;
    const displayMap = new Map<string, string>();
    for (const s of samples) displayMap.set(displayKey(s.type, s.labelLower), s.label);

    return rows.map((r) => ({
        labelLower: r.labelLower,
        type: r.type,
        userCount: Number(r.userCount),
        label: displayMap.get(displayKey(r.type, r.labelLower)) ?? r.labelLower
    }));
}

/**
 * Promote a single cluster: alias to nearest canonical or create a new one,
 * then link all UserTag rows of the cluster.
 * Returns 'aliased' | 'created' | 'skipped' for telemetry.
 */
async function promoteCluster(cluster: ClusterCandidate): Promise<'aliased' | 'created' | 'skipped'> {
    const db = getDatabase();
    const { labelLower, label, type } = cluster;

    // Embedding may be unavailable (no OPENAI_API_KEY) — skip gracefully.
    const embedding = await generateEmbedding(label);
    if (!embedding) {
        logger.warn(`[TagPromotion] Skipping "${label}" (${type}) — no embedding available`);
        return 'skipped';
    }

    // 1. Try to alias to an existing canonical.
    const similar = await findSimilarTags(embedding, 1, ALIAS_SIM_THRESHOLD);
    if (similar.length > 0) {
        const canonical = similar[0];
        // Create alias if not already present (case-insensitive on alias).
        const existingAlias = await db.tagAlias.findFirst({
            where: { tagId: canonical.id, alias: { equals: label, mode: 'insensitive' } },
            select: { id: true }
        });
        if (!existingAlias) {
            await db.tagAlias.create({ data: { tagId: canonical.id, alias: label } });
        }
        const updated = await db.userTag.updateMany({
            where: { tagId: null, labelLower, type },
            data: { tagId: canonical.id }
        });
        logger.info(
            `[TagPromotion] Aliased "${label}" (${type}) → "${canonical.label}" (sim=${canonical.similarity.toFixed(3)}, linked ${updated.count} rows)`
        );
        return 'aliased';
    }

    // 2. Create a new canonical tag.
    const domainKey = await resolveDomain(embedding);
    const created = await db.tag.create({
        data: { label, embedding, domainKey }
    });
    const updated = await db.userTag.updateMany({
        where: { tagId: null, labelLower, type },
        data: { tagId: created.id }
    });
    logger.info(
        `[TagPromotion] Created canonical "${label}" (${type}, domain=${domainKey ?? 'none'}, linked ${updated.count} rows)`
    );
    return 'created';
}

/**
 * Run a single promotion pass. Safe to call standalone (e.g. from a script).
 */
export async function runTagPromotionPass(): Promise<{ aliased: number; created: number; skipped: number }> {
    const stats = { aliased: 0, created: 0, skipped: 0 };
    try {
        const clusters = await findCandidateClusters();
        if (clusters.length === 0) {
            logger.debug('[TagPromotion] No clusters ready for promotion');
            return stats;
        }
        logger.info(`[TagPromotion] Found ${clusters.length} cluster(s) ready for promotion`);
        for (const cluster of clusters) {
            try {
                const outcome = await promoteCluster(cluster);
                stats[outcome] += 1;
            } catch (error) {
                logger.error(`[TagPromotion] Failed to promote cluster "${cluster.label}"`, error);
            }
        }
        logger.info(
            `[TagPromotion] Pass done — aliased=${stats.aliased}, created=${stats.created}, skipped=${stats.skipped}`
        );
    } catch (error) {
        logger.error('[TagPromotion] Pass failed', error);
    }
    return stats;
}

/**
 * Start the periodic tag promotion scheduler.
 * Runs once on boot, then every DEFAULT_INTERVAL_MS.
 */
export function startTagPromotionScheduler(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (intervalId) return;
    intervalId = setInterval(() => {
        runTagPromotionPass();
    }, intervalMs);
    // Fire-and-forget initial pass (don't block boot).
    runTagPromotionPass();
}

export function stopTagPromotionScheduler(): void {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
}
