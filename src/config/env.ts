import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
    ENVIRONMENT: z.enum(['dev', 'prod']).default('dev'),
    LISTEN_PORT_WS: z.coerce.number().int().positive().default(4600),
    PUBLIC_APP_URL: z.string().default('localhost'),

    LOG_LEVEL: z.enum(['minimal', 'normal', 'all']).default('normal'),
    LOG_PATH: z.string().default('./logs'),
    LOG_KEEP_DAYS: z.coerce.number().int().positive().default(30),

    SSL_PRIVATE_KEY_PATH: z.string().default(''),
    SSL_CERTIFICATE_PATH: z.string().default(''),

    DATABASE_URL: z.string().url(),

    JWT_SECRET: z.string().min(16),
    JWT_EXPIRES_IN: z.string().default('7d'),

    // Tag Promotion Batch Job (nocturne scheduling)
    TAG_PROMOTION_ENABLED: z.preprocess((v) => v === 'true' || v === '1' || v === true, z.boolean()).default(true),
    TAG_PROMOTION_WINDOW_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(2), // 02:00 UTC low-traffic window
    TAG_PROMOTION_INTERVAL_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(24 * 60 * 60 * 1000), // 24 hours

    CRYPT_KEY_MAIL: z.string().min(16),
    WS_TOKEN_EXPIRES_SECONDS: z.coerce.number().int().positive().default(60),
    MAIL_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),

    SMTP_HOST: z.string().default(''),
    SMTP_PORT: z.coerce.number().int().default(587),
    SMTP_USER: z.string().default(''),
    SMTP_PASS: z.string().default(''),
    EMAIL_FROM: z.string().default(''),

    // S3 / Minio Storage
    S3_ENDPOINT: z.string().default(''),
    S3_BUCKET: z.string().default('whymeet-uploads'),
    S3_ACCESS_KEY: z.string().default(''),
    S3_SECRET_KEY: z.string().default(''),
    S3_REGION: z.string().default('us-east-1'),
    S3_PUBLIC_URL: z.string().default(''),
    UPLOAD_MAX_SIZE: z.coerce.number().int().positive().default(5_242_880),

    // Redis
    REDIS_URL: z.string().default(''),
    REDIS_TTL_CANDIDATE_S: z.coerce.number().int().positive().default(300),
    REDIS_TTL_SETUP_S: z.coerce.number().int().positive().default(60),

    // Firebase Cloud Messaging
    FIREBASE_SERVICE_ACCOUNT: z.string().default(''),

    // OAuth providers
    GOOGLE_CLIENT_ID: z.string().default(''),
    APPLE_CLIENT_ID: z.string().default(''),
    APPLE_TEAM_ID: z.string().default(''),
    APPLE_KEY_ID: z.string().default(''),
    APPLE_PRIVATE_KEY: z.string().default(''),

    // OpenAI API Key for GPT-based features
    OPENAI_API_KEY: z.string().default(''),

    // Apple IAP Promotional Offer signing
    APPLE_IAP_KEY_ID: z.string().default(''),
    APPLE_IAP_PRIVATE_KEY: z.string().default(''),
    APP_BUNDLE_ID: z.string().default(''),

    // Device integrity verification
    INTEGRITY_CHECK_ENABLED: z.preprocess((v) => v === 'true' || v === '1' || v === true, z.boolean()).default(false),
    GOOGLE_CLOUD_PROJECT_NUMBER: z.string().default(''),
    GOOGLE_SERVICE_ACCOUNT_KEY: z.string().default(''),
    APPLE_APP_ATTEST_ENVIRONMENT: z.enum(['production', 'development']).default('production'),

    // Admin Console (HMAC-signed /admin/* API)
    ADMIN_API_SECRET: z.string().default(''),

    // Mapbox (geocoding + static map proxy)
    MAPBOX_ACCESS_TOKEN: z.string().default(''),

    // Disk cache for Mapbox static map images. Persistent forever (images
    // are immutable). Mount as a Docker volume in production.
    STATIC_MAP_CACHE_DIR: z.string().default('./cache/static-maps')
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
    process.exit(1);
}

export const env = parsed.data;
