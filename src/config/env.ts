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
    JWT_EXPIRES_IN: z.string().default('7d'),

    CRYPT_KEY_MAIL: z.string().min(16),
    WS_TOKEN_EXPIRES_SECONDS: z.coerce.number().int().positive().default(60),
    MAIL_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),

    SMTP_HOST: z.string().default(''),
    SMTP_PORT: z.coerce.number().int().default(587),
    SMTP_USER: z.string().default(''),
    SMTP_PASS: z.string().default(''),
    EMAIL_FROM: z.string().default('noreply@whymeet.app'),

    GOOGLE_CLIENT_ID: z.string().default(''),
    APPLE_CLIENT_ID: z.string().default(''),
    APPLE_TEAM_ID: z.string().default(''),
    APPLE_KEY_ID: z.string().default(''),
    APPLE_PRIVATE_KEY: z.string().default(''),

    OPENAI_API_KEY: z.string().default(''),

    // S3 / Minio Storage
    S3_ENDPOINT: z.string().default(''),
    S3_BUCKET: z.string().default('whymeet-uploads'),
    S3_ACCESS_KEY: z.string().default(''),
    S3_SECRET_KEY: z.string().default(''),
    S3_REGION: z.string().default('us-east-1'),
    S3_PUBLIC_URL: z.string().default(''),
    UPLOAD_MAX_SIZE: z.coerce.number().int().positive().default(5_242_880),

    // Firebase Cloud Messaging
    FIREBASE_SERVICE_ACCOUNT: z.string().default(''),

    // Subscription / token / swipe tuning
    FREE_DAILY_SWIPE_LIMIT: z.coerce.number().int().positive().default(20),
    FREE_DAILY_TOKEN_REFILL: z.coerce.number().int().positive().default(3),
    PREMIUM_DAILY_TOKEN_REFILL: z.coerce.number().int().positive().default(20),
    INITIAL_TOKEN_COUNT: z.coerce.number().int().nonnegative().default(5),
    SUBSCRIPTION_BOOST_DAYS: z.coerce.number().int().positive().default(10)
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
    process.exit(1);
}

export const env = parsed.data;
