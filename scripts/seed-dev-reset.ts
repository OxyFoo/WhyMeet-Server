import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { resetSeedDevData } from './seed-dev-shared';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://whymeet:whymeet@localhost:5432/whymeet?schema=public';

const adapter = new PrismaPg({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main(): Promise<void> {
    console.log('🧹 Resetting seeded dev data...');

    const result = await resetSeedDevData(prisma);

    console.log(
        `  ✅ Removed ${result.deletedUsers} seed users, ${result.deletedActivities} activities, ${result.deletedConversations} conversations, ${result.deletedProfileImages} profile images, ${result.deletedActivityImages} activity images`
    );
    console.log(
        `  ✅ Removed ${result.deletedFeedbacks} feedback rows, ${result.deletedAuditLogs} audit logs, ${result.deletedApiUsageEvents} api events, ${result.deletedEmailLogs} email logs`
    );
}

main()
    .catch((error) => {
        console.error('❌ Seed reset failed:', error);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
