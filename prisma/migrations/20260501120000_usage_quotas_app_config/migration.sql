-- Add global numeric app config table
CREATE TABLE IF NOT EXISTS "app_config" (
    "key" TEXT NOT NULL,
    "valueInt" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "app_config_pkey" PRIMARY KEY ("key")
);

-- Swipe quota now stores remaining swipes (decrement model) instead of used swipes.
ALTER TABLE "swipe_quotas" RENAME COLUMN "swipesUsed" TO "swipesRemaining";
ALTER TABLE "swipe_quotas" ALTER COLUMN "swipesRemaining" SET DEFAULT 20;

-- Best-effort conversion from previous "used" semantics to "remaining" semantics.
-- Previous default free limit was 20.
UPDATE "swipe_quotas"
SET "swipesRemaining" = GREATEST(0, 20 - "swipesRemaining");

-- Activity detail open quota (daily reset, decrement semantics)
CREATE TABLE IF NOT EXISTS "activity_view_quotas" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activityViewsRemaining" INTEGER NOT NULL DEFAULT 3,
    "resetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "activity_view_quotas_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "activity_view_quotas_userId_key" ON "activity_view_quotas"("userId");
ALTER TABLE "activity_view_quotas"
ADD CONSTRAINT "activity_view_quotas_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
