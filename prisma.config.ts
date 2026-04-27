import path from 'node:path';
import { config as dotenv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Charge .env avant que Prisma ne lise datasource.url
dotenv({ path: path.join(__dirname, '.env') });

export default defineConfig({
    schema: path.join(__dirname, 'prisma', 'schema.prisma'),
    datasource: {
        url: process.env.DATABASE_URL
    }
});
