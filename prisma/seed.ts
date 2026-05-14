import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { PrismaClient as PrismaClientType } from '@prisma/client';
import { INTENTIONS, INTENTION_CATEGORIES } from '@oxyfoo/whymeet-types';
import { APP_CONFIG_DEFAULT_ROWS } from '../src/config/usageLimitDefaults';
import { BADGE_DEFINITIONS } from '../src/reference/badges';

type DatabaseClient = Pick<
    PrismaClientType,
    'appConfig' | 'badgeDefinition' | 'intentionCatalog' | 'intentionCategoryCatalog'
>;

async function seedBadgeDefinitions(prisma: Pick<DatabaseClient, 'badgeDefinition'>): Promise<void> {
    for (const badge of BADGE_DEFINITIONS) {
        await prisma.badgeDefinition.upsert({
            where: { key: badge.key },
            update: badge,
            create: badge
        });
    }
}

export async function seedReferenceData(prisma: DatabaseClient): Promise<void> {
    for (const category of INTENTION_CATEGORIES) {
        await prisma.intentionCategoryCatalog.upsert({
            where: { key: category.key },
            update: {},
            create: { key: category.key }
        });
    }

    for (const intention of INTENTIONS) {
        await prisma.intentionCatalog.upsert({
            where: { key: intention.key },
            update: {},
            create: { key: intention.key, categoryKey: intention.categoryKey }
        });
    }

    for (const config of APP_CONFIG_DEFAULT_ROWS) {
        await prisma.appConfig.upsert({
            where: { key: config.key },
            update: {},
            create: config
        });
    }

    await seedBadgeDefinitions(prisma);
}

async function main(): Promise<void> {
    const DATABASE_URL = process.env.DATABASE_URL;

    if (!DATABASE_URL) {
        throw new Error('DATABASE_URL is required to seed reference data');
    }

    const adapter = new PrismaPg({ connectionString: DATABASE_URL });
    const prisma = new PrismaClient({ adapter });

    try {
        await seedReferenceData(prisma);
    } finally {
        await prisma.$disconnect();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error('Reference seed failed:', error);
        process.exit(1);
    });
}
