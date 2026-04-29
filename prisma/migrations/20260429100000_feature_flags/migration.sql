-- CreateTable
CREATE TABLE "feature_flags" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);
