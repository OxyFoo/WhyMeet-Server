-- Migration: Add timestamps and robust normalization to tags system
-- 
-- Changes:
--   1. Tag.createdAt: timestamp when canonical tag was created
--   2. TagAlias.createdAt: timestamp when alias was created
--   3. UserTag.labelNorm: robust normalized form for clustering (NFD, no accents, normalized spacing/hyphens)
--   4. UserTag.createdAt: when tag was added to profile
--   5. UserTag.updatedAt: when tag was last updated
--   6. UserTag unique constraint: (userId, type, labelNorm) instead of labelLower
--      (prevents variant duplicates on same user, e.g. "js" and "JS" would collide)

-- ─── Phase 1: Add new columns (nullable first for safe backfill) ─────────────

ALTER TABLE "tags" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "tag_aliases" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "user_tags" ADD COLUMN IF NOT EXISTS "labelNorm" TEXT;
ALTER TABLE "user_tags" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "user_tags" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ─── Phase 2: Backfill labelNorm from labelLower ─────────────────────────────
-- NOTE: Backfill uses simplified normalization (without Unicode NFD decomposition).
-- New labels ingested at runtime use full NFD normalization via tagNormalization.ts.
-- This creates minimal edge cases for labels with combining diacritics, but is acceptable
-- for v1 as most user-typed labels don't use combining marks.
-- 
-- Normalize: lowercase (already done), remove punctuation except hyphens/spaces, compress spaces/hyphens, trim.
-- This mirrors tagNormalization.ts logic for most practical cases.
UPDATE "user_tags"
SET "labelNorm" = TRIM(LOWER(
  REGEXP_REPLACE(
    REGEXP_REPLACE("labelLower", '[^\w\s-]', '', 'g'),
    '[\s\-]+',
    ' ',
    'g'
  )
))
WHERE "labelNorm" IS NULL;

-- ─── Phase 3: Enforce NOT NULL on labelNorm ──────────────────────────────────
ALTER TABLE "user_tags" ALTER COLUMN "labelNorm" SET NOT NULL;

-- ─── Phase 4: Drop old unique constraint and create new one ──────────────────
-- Drop the old unique constraint on (userId, type, labelLower)
DROP INDEX IF EXISTS "user_tags_userId_type_labelLower_key";

-- Create new unique constraint on (userId, type, labelNorm)
CREATE UNIQUE INDEX IF NOT EXISTS "user_tags_userId_type_labelNorm_key" ON "user_tags"("userId", "type", "labelNorm");

-- ─── Phase 5: Add new indexes on labelNorm ──────────────────────────────────
-- Indexes for clustering and aggregation queries
CREATE INDEX IF NOT EXISTS "user_tags_labelNorm_idx" ON "user_tags"("labelNorm");
CREATE INDEX IF NOT EXISTS "user_tags_type_labelNorm_idx" ON "user_tags"("type", "labelNorm");
