CREATE TABLE "login_bypass_emails" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_bypass_emails_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "login_bypass_emails_email_key" ON "login_bypass_emails"("email");
CREATE INDEX "login_bypass_emails_createdAt_idx" ON "login_bypass_emails"("createdAt");
