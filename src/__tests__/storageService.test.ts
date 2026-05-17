const mockSend = jest.fn();
const mockS3Client = jest.fn(() => ({ send: mockSend }));
const mockDeleteObjectCommand = jest.fn((input) => ({ input }));

jest.mock('@aws-sdk/client-s3', () => ({
    S3Client: mockS3Client,
    PutObjectCommand: jest.fn((input) => ({ input })),
    DeleteObjectCommand: mockDeleteObjectCommand,
    HeadBucketCommand: jest.fn((input) => ({ input })),
    CreateBucketCommand: jest.fn((input) => ({ input })),
    PutBucketPolicyCommand: jest.fn((input) => ({ input }))
}));

jest.mock('@/config/env', () => ({
    env: {
        S3_ENDPOINT: 'http://minio.local:9000',
        S3_BUCKET: 'whymeet-uploads',
        S3_ACCESS_KEY: 'key',
        S3_SECRET_KEY: 'secret',
        S3_REGION: 'us-east-1',
        S3_PUBLIC_URL: 'http://cdn.local/whymeet-uploads'
    }
}));

jest.mock('@/config/logger', () => ({
    logger: {
        debug: jest.fn(),
        warn: jest.fn()
    }
}));

import { deleteFile, resolveStorageKey } from '@/services/storageService';

describe('storageService deletion', () => {
    beforeEach(() => {
        mockSend.mockReset();
        mockDeleteObjectCommand.mockClear();
        mockS3Client.mockClear();
    });

    it('resolves public S3 urls to object keys', () => {
        expect(resolveStorageKey('http://cdn.local/whymeet-uploads/photos/user-1/photo.webp')).toBe(
            'photos/user-1/photo.webp'
        );
        expect(resolveStorageKey('http://minio.local:9000/whymeet-uploads/photos/user-1/photo.webp')).toBe(
            'photos/user-1/photo.webp'
        );
    });

    it('deletes a raw object key as-is', async () => {
        await deleteFile('photos/user-1/photo.webp');

        expect(mockDeleteObjectCommand).toHaveBeenCalledWith({
            Bucket: 'whymeet-uploads',
            Key: 'photos/user-1/photo.webp'
        });
        expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('deletes a public S3 url by converting it to the stored key', async () => {
        await deleteFile('http://cdn.local/whymeet-uploads/photos/user-1/photo.webp');

        expect(mockDeleteObjectCommand).toHaveBeenCalledWith({
            Bucket: 'whymeet-uploads',
            Key: 'photos/user-1/photo.webp'
        });
        expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('ignores foreign external urls', async () => {
        await deleteFile('https://example.com/photo.webp');

        expect(mockDeleteObjectCommand).not.toHaveBeenCalled();
        expect(mockSend).not.toHaveBeenCalled();
    });
});
