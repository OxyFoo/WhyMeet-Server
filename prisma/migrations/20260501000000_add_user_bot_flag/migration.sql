-- AlterTable
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "bot" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "users_bot_idx" ON "users"("bot");
