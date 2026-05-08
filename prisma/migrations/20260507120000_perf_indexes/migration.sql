-- Performance indexes for high-volume discovery, activity feeds and realtime notification paths.
-- These are raw PostgreSQL indexes because Prisma schema indexes cannot express partial indexes,
-- GIN array indexes, or CONCURRENTLY.

-- ─── People discovery ──────────────────────────────────────────────────────

CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_active_bot_createdAt_idx"
    ON "users" ("bot", "createdAt" DESC)
    WHERE "banned" = false
      AND "suspended" = false
      AND "deleted" = false
      AND "birthDate" IS NOT NULL
      AND "name" <> '';

CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_active_birthDate_idx"
    ON "users" ("birthDate")
    WHERE "banned" = false
      AND "suspended" = false
      AND "deleted" = false
      AND "birthDate" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_active_gender_verified_bot_idx"
    ON "users" ("gender", "verified", "bot")
    WHERE "banned" = false
      AND "suspended" = false
      AND "deleted" = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "profiles_intentions_gin_idx"
    ON "profiles" USING GIN ("intentions");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "profiles_spokenLanguages_gin_idx"
    ON "profiles" USING GIN ("spokenLanguages");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "profiles_geo_idx"
    ON "profiles" ("latitude", "longitude")
    WHERE "latitude" IS NOT NULL
      AND "longitude" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "settings_visibilityGenders_gin_idx"
    ON "settings" USING GIN ("visibilityGenders");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "settings_visibility_age_idx"
    ON "settings" ("visibilityAgeMin", "visibilityAgeMax");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "user_tags_labelLower_userId_idx"
    ON "user_tags" ("labelLower", "userId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "user_tags_type_labelLower_userId_idx"
    ON "user_tags" ("type", "labelLower", "userId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "profile_photos_userId_position_idx"
    ON "profile_photos" ("userId", "position");

-- ─── Exclusion and moderation cache seeding ────────────────────────────────

CREATE INDEX CONCURRENTLY IF NOT EXISTS "matches_senderId_matchedAt_idx"
    ON "matches" ("senderId", "matchedAt" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "reports_reporterId_createdAt_idx"
    ON "reports" ("reporterId", "createdAt" DESC);

-- ─── Activities discovery ──────────────────────────────────────────────────

CREATE INDEX CONCURRENTLY IF NOT EXISTS "activities_active_category_date_idx"
    ON "activities" ("category", "dateTime", "createdAt" DESC)
    WHERE "isCancelled" = false
      AND "isArchived" = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "activities_active_date_idx"
    ON "activities" ("dateTime", "createdAt" DESC)
    WHERE "isCancelled" = false
      AND "isArchived" = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "activities_active_geo_idx"
    ON "activities" ("latitude", "longitude")
    WHERE "isCancelled" = false
      AND "isArchived" = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "activity_photos_activityId_position_idx"
    ON "activity_photos" ("activityId", "position");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "activity_participants_activityId_confirmedAttendance_idx"
    ON "activity_participants" ("activityId", "confirmedAttendance");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "activity_reports_reporterId_createdAt_idx"
    ON "activity_reports" ("reporterId", "createdAt" DESC);

-- ─── Feed and messaging pagination ─────────────────────────────────────────

CREATE INDEX CONCURRENTLY IF NOT EXISTS "notifications_userId_createdAt_idx"
    ON "notifications" ("userId", "createdAt" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "messages_senderId_timestamp_idx"
    ON "messages" ("senderId", "timestamp" DESC);

ANALYZE "users";
ANALYZE "profiles";
ANALYZE "settings";
ANALYZE "user_tags";
ANALYZE "profile_photos";
ANALYZE "matches";
ANALYZE "reports";
ANALYZE "activities";
ANALYZE "activity_photos";
ANALYZE "activity_participants";
ANALYZE "activity_reports";
ANALYZE "notifications";
ANALYZE "messages";
