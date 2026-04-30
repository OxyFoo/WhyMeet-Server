-- Refactor user_tags: store the raw user-typed label + lowercase variant,
-- make the canonical Tag link optional. Existing rows keep their canonical
-- link and inherit the canonical label as their initial raw label.

-- DropForeignKey
ALTER TABLE "user_tags" DROP CONSTRAINT "user_tags_tagId_fkey";

-- DropIndex
DROP INDEX "user_tags_userId_tagId_type_key";

-- AlterTable: add nullable columns first so we can backfill safely
ALTER TABLE "user_tags" ADD COLUMN "label" TEXT;
ALTER TABLE "user_tags" ADD COLUMN "labelLower" TEXT;

-- Backfill from the canonical Tag.label
UPDATE "user_tags" ut
SET "label" = t."label",
    "labelLower" = LOWER(t."label")
FROM "tags" t
WHERE ut."tagId" = t."id";

-- Enforce NOT NULL after backfill
ALTER TABLE "user_tags" ALTER COLUMN "label" SET NOT NULL;
ALTER TABLE "user_tags" ALTER COLUMN "labelLower" SET NOT NULL;

-- Make tagId optional (UserTag may exist without a canonical Tag)
ALTER TABLE "user_tags" ALTER COLUMN "tagId" DROP NOT NULL;

-- New unique constraint and indexes
CREATE UNIQUE INDEX "user_tags_userId_type_labelLower_key" ON "user_tags"("userId", "type", "labelLower");
CREATE INDEX "user_tags_labelLower_idx" ON "user_tags"("labelLower");
CREATE INDEX "user_tags_type_labelLower_idx" ON "user_tags"("type", "labelLower");

-- Re-add FK on tagId with SET NULL on delete (was CASCADE)
ALTER TABLE "user_tags" ADD CONSTRAINT "user_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;
