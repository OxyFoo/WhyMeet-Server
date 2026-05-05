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

-- CreateIndex
CREATE UNIQUE INDEX "premium_overrides_userId_key" ON "premium_overrides"("userId");

-- CreateIndex
CREATE INDEX "premium_overrides_expiresAt_idx" ON "premium_overrides"("expiresAt");

-- CreateIndex
CREATE INDEX "premium_overrides_forcedPremium_expiresAt_idx" ON "premium_overrides"("forcedPremium", "expiresAt");

-- AddForeignKey
ALTER TABLE "premium_overrides" ADD CONSTRAINT "premium_overrides_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
