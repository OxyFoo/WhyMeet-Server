-- AlterTable
ALTER TABLE "app_config" ADD COLUMN     "valueString" TEXT,
ALTER COLUMN "valueInt" DROP NOT NULL;

-- AlterTable
ALTER TABLE "profiles" ALTER COLUMN "preferredDiscoveryView" SET DEFAULT 'advanced';
