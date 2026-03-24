import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
    ENVIRONMENT: z.enum(['dev', 'prod']).default('dev'),
    LISTEN_PORT_WS: z.coerce.number().int().positive().default(4600),
    DOMAIN: z.string().default('localhost'),

    LOG_LEVEL: z.enum(['minimal', 'normal', 'all']).default('normal'),
    LOG_PATH: z.string().default('./logs'),
    LOG_KEEP_DAYS: z.coerce.number().int().positive().default(30),

    SSL_PRIVATE_KEY_PATH: z.string().default(''),
    SSL_CERTIFICATE_PATH: z.string().default(''),

    DATABASE_URL: z.string().url(),

    JWT_SECRET: z.string().min(16),
    JWT_EXPIRES_IN: z.string().default('7d')
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
    process.exit(1);
}

export const env = parsed.data;
