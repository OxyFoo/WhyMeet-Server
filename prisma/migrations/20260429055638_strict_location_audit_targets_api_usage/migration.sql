/*
  Warnings:

  - Made the column `latitude` on table `activities` required. This step will fail if there are existing NULL values in that column.
  - Made the column `longitude` on table `activities` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "activities" ALTER COLUMN "locationName" DROP DEFAULT,
ALTER COLUMN "latitude" SET NOT NULL,
ALTER COLUMN "longitude" SET NOT NULL;

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "targetActivityId" TEXT;

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

-- CreateIndex
CREATE INDEX "api_usage_events_provider_createdAt_idx" ON "api_usage_events"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "api_usage_events_provider_status_createdAt_idx" ON "api_usage_events"("provider", "status", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_targetActivityId_createdAt_idx" ON "audit_logs"("targetActivityId", "createdAt");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_targetActivityId_fkey" FOREIGN KEY ("targetActivityId") REFERENCES "activities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
