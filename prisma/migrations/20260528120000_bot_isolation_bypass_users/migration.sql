CREATE TABLE "bot_isolation_bypass_users" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_isolation_bypass_users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bot_isolation_bypass_users_userId_key" ON "bot_isolation_bypass_users"("userId");
CREATE INDEX "bot_isolation_bypass_users_createdAt_idx" ON "bot_isolation_bypass_users"("createdAt");

ALTER TABLE "bot_isolation_bypass_users"
ADD CONSTRAINT "bot_isolation_bypass_users_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
