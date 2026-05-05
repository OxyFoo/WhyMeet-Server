-- Unify the three daily-quota tables under a consistent naming scheme:
--   token_balances      -> search_quotas      (tokens -> remaining, lastRefillAt -> resetAt)
--   swipe_quotas        -> swipe_quotas       (swipesRemaining -> remaining)
--   activity_view_quotas -> activity_quotas   (activityViewsRemaining -> remaining)
--
-- All three now share the same shape: { id, userId, remaining, resetAt }.

-- search_quotas (was token_balances)
ALTER TABLE "token_balances" RENAME TO "search_quotas";
ALTER TABLE "search_quotas" RENAME COLUMN "tokens" TO "remaining";
ALTER TABLE "search_quotas" RENAME COLUMN "lastRefillAt" TO "resetAt";
UPDATE "search_quotas"
SET "resetAt" = date_trunc('day', "resetAt") + INTERVAL '1 day';
ALTER INDEX IF EXISTS "token_balances_pkey" RENAME TO "search_quotas_pkey";
ALTER INDEX IF EXISTS "token_balances_userId_key" RENAME TO "search_quotas_userId_key";
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'token_balances_userId_fkey') THEN
		ALTER TABLE "search_quotas" RENAME CONSTRAINT "token_balances_userId_fkey" TO "search_quotas_userId_fkey";
	END IF;
END $$;

-- swipe_quotas (only column rename)
ALTER TABLE "swipe_quotas" RENAME COLUMN "swipesRemaining" TO "remaining";

-- activity_quotas (was activity_view_quotas)
ALTER TABLE "activity_view_quotas" RENAME TO "activity_quotas";
ALTER TABLE "activity_quotas" RENAME COLUMN "activityViewsRemaining" TO "remaining";
ALTER INDEX IF EXISTS "activity_view_quotas_pkey" RENAME TO "activity_quotas_pkey";
ALTER INDEX IF EXISTS "activity_view_quotas_userId_key" RENAME TO "activity_quotas_userId_key";
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_view_quotas_userId_fkey') THEN
		ALTER TABLE "activity_quotas" RENAME CONSTRAINT "activity_view_quotas_userId_fkey" TO "activity_quotas_userId_fkey";
	END IF;
END $$;
