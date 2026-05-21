-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "birthDate" TIMESTAMP(3),
    "birthDateLastChangedAt" TIMESTAMP(3),
    "gender" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "banned" BOOLEAN NOT NULL DEFAULT false,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "suspendedAt" TIMESTAMP(3),
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "appealMessage" VARCHAR(500),
    "appealRequestedAt" TIMESTAMP(3),
    "preferredPeriod" TEXT NOT NULL DEFAULT 'any',
    "underageDeclared" BOOLEAN NOT NULL DEFAULT false,
    "bot" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "uuid" TEXT NOT NULL,
    "sessionTokenHash" TEXT NOT NULL,
    "mailTokenHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "name" TEXT NOT NULL DEFAULT '',
    "os" TEXT NOT NULL DEFAULT '',
    "pushToken" TEXT,
    "pushProvider" TEXT,
    "lastIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "integrityVerifiedAt" TIMESTAMP(3),
    "userId" TEXT,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bio" TEXT NOT NULL DEFAULT '',
    "socialVibe" TEXT NOT NULL DEFAULT 'balanced',
    "country" TEXT NOT NULL DEFAULT '',
    "region" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "statConnections" INTEGER NOT NULL DEFAULT 0,
    "statMatches" INTEGER NOT NULL DEFAULT 0,
    "statVibes" INTEGER NOT NULL DEFAULT 0,
    "intentionKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "intentionCategoryKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "spokenLanguages" TEXT[] DEFAULT ARRAY['fr']::TEXT[],
    "trustScore" INTEGER NOT NULL DEFAULT 0,
    "completedHostedCount" INTEGER NOT NULL DEFAULT 0,
    "cancelledHostedCount" INTEGER NOT NULL DEFAULT 0,
    "preferredDiscoveryView" TEXT NOT NULL DEFAULT 'swipe',

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'fr',
    "theme" TEXT NOT NULL DEFAULT 'light',
    "peopleAgeMin" INTEGER NOT NULL DEFAULT 18,
    "peopleAgeMax" INTEGER NOT NULL DEFAULT 99,
    "peopleGenders" TEXT[] DEFAULT ARRAY['male', 'female', 'non_binary', 'other', 'prefer_not_to_say']::TEXT[],
    "peopleMaxDistance" INTEGER NOT NULL DEFAULT 50,
    "peopleRemoteMode" BOOLEAN NOT NULL DEFAULT false,
    "peopleVerified" BOOLEAN NOT NULL DEFAULT false,
    "peoplePhotosOnly" BOOLEAN NOT NULL DEFAULT false,
    "peopleLanguages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "activityGenders" TEXT[] DEFAULT ARRAY['male', 'female', 'non_binary', 'other', 'prefer_not_to_say']::TEXT[],
    "activityMaxDistance" INTEGER NOT NULL DEFAULT 50,
    "activityRemoteMode" BOOLEAN NOT NULL DEFAULT false,
    "activityVerified" BOOLEAN NOT NULL DEFAULT false,
    "activityLanguages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "syncVisibility" BOOLEAN NOT NULL DEFAULT true,
    "visibilityAgeMin" INTEGER NOT NULL DEFAULT 18,
    "visibilityAgeMax" INTEGER NOT NULL DEFAULT 99,
    "visibilityGenders" TEXT[] DEFAULT ARRAY['male', 'female', 'non_binary', 'other', 'prefer_not_to_say']::TEXT[],
    "visibilityMaxDistance" INTEGER NOT NULL DEFAULT 50,
    "visibilityRemoteMode" BOOLEAN NOT NULL DEFAULT false,
    "notifNewMatch" BOOLEAN NOT NULL DEFAULT true,
    "notifLikes" BOOLEAN NOT NULL DEFAULT true,
    "notifMessages" BOOLEAN NOT NULL DEFAULT true,
    "notifNearbyPeople" BOOLEAN NOT NULL DEFAULT true,
    "notifActivityReminder24h" BOOLEAN NOT NULL DEFAULT true,
    "notifActivityReminder1h" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_photos" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "keyBlurred" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "embedding" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "domainKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tag_aliases" (
    "id" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tag_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_tags" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "labelLower" TEXT NOT NULL,
    "labelNorm" TEXT NOT NULL,
    "tagId" TEXT,
    "type" TEXT NOT NULL,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "matchContext" TEXT NOT NULL DEFAULT '',
    "categoryKey" TEXT,
    "intentionKey" TEXT,
    "mutual" BOOLEAN NOT NULL DEFAULT false,
    "matchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intention_categories" (
    "key" TEXT NOT NULL,

    CONSTRAINT "intention_categories_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "intentions" (
    "key" TEXT NOT NULL,
    "categoryKey" TEXT NOT NULL,

    CONSTRAINT "intentions_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "isGroup" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_participants" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "conversation_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'text',
    "read" BOOLEAN NOT NULL DEFAULT false,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activityId" TEXT,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "activityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocks" (
    "id" TEXT NOT NULL,
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reportedId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'profile',
    "sourceId" TEXT,
    "message" VARCHAR(500) NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "isLegitimate" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ip_logs" (
    "id" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ip_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suspicious_activities" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "signals" JSONB NOT NULL,
    "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedByAdminId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByAdminId" TEXT,
    "notes" VARCHAR(1000),

    CONSTRAINT "suspicious_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "targetActivityId" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_usage_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "userId" TEXT,
    "errorCode" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "app_config" (
    "key" TEXT NOT NULL,
    "valueInt" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_config_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "email_logs" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "recipientUserId" TEXT,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "metadata" JSONB,
    "sentBy" TEXT NOT NULL,
    "actorAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_auto_config" (
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "email_auto_config_pkey" PRIMARY KEY ("type")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "platform" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "originalTransactionId" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "premium_overrides" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "forcedPremium" BOOLEAN NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "premium_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "active_boosts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "active_boosts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_quotas" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "remaining" INTEGER NOT NULL DEFAULT 5,
    "resetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_quotas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "swipe_quotas" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "remaining" INTEGER NOT NULL DEFAULT 20,
    "resetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "swipe_quotas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_quotas" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "remaining" INTEGER NOT NULL DEFAULT 3,
    "resetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_quotas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_opens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_opens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activities" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL,
    "dateTime" TIMESTAMP(3),
    "durationMinutes" INTEGER,
    "locationName" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "maxParticipants" INTEGER,
    "isCancelled" BOOLEAN NOT NULL DEFAULT false,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "hostConfirmedAt" TIMESTAMP(3),
    "hostReportedAttendees" INTEGER,
    "targetGenders" TEXT[] DEFAULT ARRAY['male', 'female', 'non_binary', 'other', 'prefer_not_to_say']::TEXT[],
    "targetAgeRange" INTEGER[] DEFAULT ARRAY[18, 80]::INTEGER[],
    "conversationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_participants" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAttendance" BOOLEAN,

    CONSTRAINT "activity_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_photos" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "keyBlurred" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_reports" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "message" VARCHAR(500) NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "isLegitimate" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_scheduled_notifs" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "sent" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "activity_scheduled_notifs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "badge_definitions" (
    "key" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "threshold" INTEGER,
    "displayOrder" INTEGER NOT NULL,
    "rewardType" TEXT,
    "rewardOfferIdApple" TEXT,
    "rewardOfferIdGoogle" TEXT,
    "rewardDescription" TEXT,

    CONSTRAINT "badge_definitions_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "user_badges" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "badgeKey" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "earned" BOOLEAN NOT NULL DEFAULT false,
    "earnedAt" TIMESTAMP(3),
    "rewardPendingAt" TIMESTAMP(3),
    "rewardClaimedAt" TIMESTAMP(3),

    CONSTRAINT "user_badges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedbacks" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "message" VARCHAR(1000) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_events" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "platform" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL,
    "props" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_daily_metrics" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "dimension" TEXT NOT NULL DEFAULT '',
    "count" INTEGER NOT NULL DEFAULT 0,
    "uniqueDevices" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analytics_daily_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_bot_idx" ON "users"("bot");

-- CreateIndex
CREATE INDEX "users_underageDeclared_idx" ON "users"("underageDeclared");

-- CreateIndex
CREATE UNIQUE INDEX "devices_uuid_key" ON "devices"("uuid");

-- CreateIndex
CREATE INDEX "devices_userId_idx" ON "devices"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_userId_key" ON "profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "settings_userId_key" ON "settings"("userId");

-- CreateIndex
CREATE INDEX "profile_photos_userId_idx" ON "profile_photos"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "tags_label_key" ON "tags"("label");

-- CreateIndex
CREATE INDEX "tags_domainKey_idx" ON "tags"("domainKey");

-- CreateIndex
CREATE UNIQUE INDEX "tag_aliases_alias_key" ON "tag_aliases"("alias");

-- CreateIndex
CREATE INDEX "tag_aliases_tagId_idx" ON "tag_aliases"("tagId");

-- CreateIndex
CREATE INDEX "user_tags_tagId_idx" ON "user_tags"("tagId");

-- CreateIndex
CREATE INDEX "user_tags_userId_source_idx" ON "user_tags"("userId", "source");

-- CreateIndex
CREATE INDEX "user_tags_labelLower_idx" ON "user_tags"("labelLower");

-- CreateIndex
CREATE INDEX "user_tags_labelNorm_idx" ON "user_tags"("labelNorm");

-- CreateIndex
CREATE INDEX "user_tags_type_labelNorm_idx" ON "user_tags"("type", "labelNorm");

-- CreateIndex
CREATE UNIQUE INDEX "user_tags_userId_type_labelNorm_key" ON "user_tags"("userId", "type", "labelNorm");

-- CreateIndex
CREATE INDEX "matches_receiverId_idx" ON "matches"("receiverId");

-- CreateIndex
CREATE UNIQUE INDEX "matches_senderId_receiverId_category_key" ON "matches"("senderId", "receiverId", "category");

-- CreateIndex
CREATE INDEX "intentions_categoryKey_idx" ON "intentions"("categoryKey");

-- CreateIndex
CREATE INDEX "conversations_lastMessageAt_id_idx" ON "conversations"("lastMessageAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "conversation_participants_userId_idx" ON "conversation_participants"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_participants_conversationId_userId_key" ON "conversation_participants"("conversationId", "userId");

-- CreateIndex
CREATE INDEX "messages_conversationId_timestamp_idx" ON "messages"("conversationId", "timestamp");

-- CreateIndex
CREATE INDEX "messages_senderId_idx" ON "messages"("senderId");

-- CreateIndex
CREATE INDEX "messages_activityId_idx" ON "messages"("activityId");

-- CreateIndex
CREATE INDEX "notifications_userId_read_idx" ON "notifications"("userId", "read");

-- CreateIndex
CREATE INDEX "blocks_blockedId_idx" ON "blocks"("blockedId");

-- CreateIndex
CREATE UNIQUE INDEX "blocks_blockerId_blockedId_key" ON "blocks"("blockerId", "blockedId");

-- CreateIndex
CREATE INDEX "reports_reportedId_idx" ON "reports"("reportedId");

-- CreateIndex
CREATE INDEX "reports_status_idx" ON "reports"("status");

-- CreateIndex
CREATE UNIQUE INDEX "reports_reporterId_reportedId_key" ON "reports"("reporterId", "reportedId");

-- CreateIndex
CREATE INDEX "ip_logs_ip_idx" ON "ip_logs"("ip");

-- CreateIndex
CREATE INDEX "ip_logs_userId_idx" ON "ip_logs"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "suspicious_activities_userId_key" ON "suspicious_activities"("userId");

-- CreateIndex
CREATE INDEX "suspicious_activities_score_idx" ON "suspicious_activities"("score");

-- CreateIndex
CREATE INDEX "suspicious_activities_lastDetectedAt_idx" ON "suspicious_activities"("lastDetectedAt");

-- CreateIndex
CREATE INDEX "suspicious_activities_resolvedAt_idx" ON "suspicious_activities"("resolvedAt");

-- CreateIndex
CREATE INDEX "audit_logs_userId_action_idx" ON "audit_logs"("userId", "action");

-- CreateIndex
CREATE INDEX "audit_logs_targetActivityId_createdAt_idx" ON "audit_logs"("targetActivityId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "api_usage_events_provider_createdAt_idx" ON "api_usage_events"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "api_usage_events_provider_status_createdAt_idx" ON "api_usage_events"("provider", "status", "createdAt");

-- CreateIndex
CREATE INDEX "email_logs_type_createdAt_idx" ON "email_logs"("type", "createdAt");

-- CreateIndex
CREATE INDEX "email_logs_recipientEmail_idx" ON "email_logs"("recipientEmail");

-- CreateIndex
CREATE INDEX "email_logs_status_createdAt_idx" ON "email_logs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "email_logs_createdAt_idx" ON "email_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_userId_key" ON "subscriptions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "premium_overrides_userId_key" ON "premium_overrides"("userId");

-- CreateIndex
CREATE INDEX "premium_overrides_expiresAt_idx" ON "premium_overrides"("expiresAt");

-- CreateIndex
CREATE INDEX "premium_overrides_forcedPremium_expiresAt_idx" ON "premium_overrides"("forcedPremium", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "active_boosts_userId_key" ON "active_boosts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "search_quotas_userId_key" ON "search_quotas"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "swipe_quotas_userId_key" ON "swipe_quotas"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_quotas_userId_key" ON "activity_quotas"("userId");

-- CreateIndex
CREATE INDEX "activity_opens_userId_day_idx" ON "activity_opens"("userId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "activity_opens_userId_activityId_day_key" ON "activity_opens"("userId", "activityId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "activities_conversationId_key" ON "activities"("conversationId");

-- CreateIndex
CREATE INDEX "activities_hostId_idx" ON "activities"("hostId");

-- CreateIndex
CREATE INDEX "activities_category_idx" ON "activities"("category");

-- CreateIndex
CREATE INDEX "activities_dateTime_idx" ON "activities"("dateTime");

-- CreateIndex
CREATE INDEX "activity_participants_userId_idx" ON "activity_participants"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_participants_activityId_userId_key" ON "activity_participants"("activityId", "userId");

-- CreateIndex
CREATE INDEX "activity_photos_activityId_idx" ON "activity_photos"("activityId");

-- CreateIndex
CREATE INDEX "activity_reports_activityId_idx" ON "activity_reports"("activityId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_reports_reporterId_activityId_key" ON "activity_reports"("reporterId", "activityId");

-- CreateIndex
CREATE INDEX "activity_scheduled_notifs_scheduledAt_sent_idx" ON "activity_scheduled_notifs"("scheduledAt", "sent");

-- CreateIndex
CREATE UNIQUE INDEX "activity_scheduled_notifs_activityId_type_key" ON "activity_scheduled_notifs"("activityId", "type");

-- CreateIndex
CREATE INDEX "user_badges_userId_earned_idx" ON "user_badges"("userId", "earned");

-- CreateIndex
CREATE UNIQUE INDEX "user_badges_userId_badgeKey_key" ON "user_badges"("userId", "badgeKey");

-- CreateIndex
CREATE INDEX "feedbacks_userId_idx" ON "feedbacks"("userId");

-- CreateIndex
CREATE INDEX "feedbacks_type_idx" ON "feedbacks"("type");

-- CreateIndex
CREATE INDEX "analytics_events_name_ts_idx" ON "analytics_events"("name", "ts");

-- CreateIndex
CREATE INDEX "analytics_events_ts_idx" ON "analytics_events"("ts");

-- CreateIndex
CREATE INDEX "analytics_events_deviceId_ts_idx" ON "analytics_events"("deviceId", "ts");

-- CreateIndex
CREATE INDEX "analytics_daily_metrics_name_date_idx" ON "analytics_daily_metrics"("name", "date");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_daily_metrics_date_name_dimension_key" ON "analytics_daily_metrics"("date", "name", "dimension");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings" ADD CONSTRAINT "settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_photos" ADD CONSTRAINT "profile_photos_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_aliases" ADD CONSTRAINT "tag_aliases_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_tags" ADD CONSTRAINT "user_tags_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_tags" ADD CONSTRAINT "user_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_categoryKey_fkey" FOREIGN KEY ("categoryKey") REFERENCES "intention_categories"("key") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_intentionKey_fkey" FOREIGN KEY ("intentionKey") REFERENCES "intentions"("key") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intentions" ADD CONSTRAINT "intentions_categoryKey_fkey" FOREIGN KEY ("categoryKey") REFERENCES "intention_categories"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "activities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reportedId_fkey" FOREIGN KEY ("reportedId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ip_logs" ADD CONSTRAINT "ip_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ip_logs" ADD CONSTRAINT "ip_logs_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suspicious_activities" ADD CONSTRAINT "suspicious_activities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_targetActivityId_fkey" FOREIGN KEY ("targetActivityId") REFERENCES "activities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "premium_overrides" ADD CONSTRAINT "premium_overrides_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "active_boosts" ADD CONSTRAINT "active_boosts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_quotas" ADD CONSTRAINT "search_quotas_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swipe_quotas" ADD CONSTRAINT "swipe_quotas_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_quotas" ADD CONSTRAINT "activity_quotas_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_opens" ADD CONSTRAINT "activity_opens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_opens" ADD CONSTRAINT "activity_opens_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "activities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_participants" ADD CONSTRAINT "activity_participants_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "activities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_participants" ADD CONSTRAINT "activity_participants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_photos" ADD CONSTRAINT "activity_photos_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "activities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_reports" ADD CONSTRAINT "activity_reports_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_reports" ADD CONSTRAINT "activity_reports_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "activities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_scheduled_notifs" ADD CONSTRAINT "activity_scheduled_notifs_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "activities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_badgeKey_fkey" FOREIGN KEY ("badgeKey") REFERENCES "badge_definitions"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedbacks" ADD CONSTRAINT "feedbacks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

