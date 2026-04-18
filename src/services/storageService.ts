import {
    S3Client,
    PutObjectCommand,
    DeleteObjectCommand,
    HeadBucketCommand,
    CreateBucketCommand,
    PutBucketPolicyCommand
} from '@aws-sdk/client-s3';
import { env } from '@/config/env';
import { logger } from '@/config/logger';

let s3: S3Client | null = null;

function getS3Client(): S3Client | null {
    if (s3) return s3;
    if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) {
        return null;
    }

    s3 = new S3Client({
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION,
        credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
        forcePathStyle: true
    });
    return s3;
}

export async function initStorage(): Promise<void> {
    const client = getS3Client();
    if (!client) return;

    try {
        await client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
    } catch {
        logger.debug(`[Storage] Bucket "${env.S3_BUCKET}" not found, creating...`);
        await client.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
    }

    // Allow public read access (needed for avatar URLs)
    const policy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [
            {
                Effect: 'Allow',
                Principal: '*',
                Action: ['s3:GetObject'],
                Resource: [`arn:aws:s3:::${env.S3_BUCKET}/*`]
            }
        ]
    });
    await client.send(new PutBucketPolicyCommand({ Bucket: env.S3_BUCKET, Policy: policy }));

    logger.debug(`[Storage] Bucket "${env.S3_BUCKET}" ready (public-read)`);
}

export async function uploadFile(buffer: Buffer, key: string, contentType: string): Promise<string | null> {
    const client = getS3Client();
    if (!client) return null;

    await client.send(
        new PutObjectCommand({
            Bucket: env.S3_BUCKET,
            Key: key,
            Body: buffer,
            ContentType: contentType,
            CacheControl: 'public, max-age=31536000'
        })
    );

    return key;
}

export async function deleteFile(key: string): Promise<void> {
    const client = getS3Client();
    if (!client) return;

    try {
        await client.send(
            new DeleteObjectCommand({
                Bucket: env.S3_BUCKET,
                Key: key
            })
        );
    } catch (error) {
        logger.warn('[Storage] Failed to delete file', error);
    }
}

export function getPublicUrl(key: string): string {
    if (env.S3_PUBLIC_URL) {
        return `${env.S3_PUBLIC_URL}/${key}`;
    }
    return `${env.S3_ENDPOINT}/${env.S3_BUCKET}/${key}`;
}

/**
 * Extract the S3 key from a full avatar URL.
 * Returns null if the URL is not an S3 URL.
 */
export function extractKeyFromUrl(url: string): string | null {
    if (!url) return null;

    const publicPrefix = env.S3_PUBLIC_URL ? `${env.S3_PUBLIC_URL}/` : null;
    if (publicPrefix && url.startsWith(publicPrefix)) {
        return url.slice(publicPrefix.length);
    }

    const endpointPrefix = `${env.S3_ENDPOINT}/${env.S3_BUCKET}/`;
    if (url.startsWith(endpointPrefix)) {
        return url.slice(endpointPrefix.length);
    }

    return null;
}
