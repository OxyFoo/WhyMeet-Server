import crypto from 'crypto';
import {
    buildBlurredImageKey,
    createActivityPhotoVariants,
    createProfilePhotoVariants,
    type PhotoImageVariants
} from '@/services/imageVariants';
import { deleteFile, uploadFile } from '@/services/storageService';

export interface StoredImagePair {
    key: string;
    keyBlurred: string;
}

async function uploadImagePair(
    variants: PhotoImageVariants,
    key: string,
    keyBlurred: string
): Promise<StoredImagePair | null> {
    let storedKey: string | null = null;
    try {
        storedKey = await uploadFile(variants.normal, key, 'image/webp');
        if (!storedKey) return null;

        const storedKeyBlurred = await uploadFile(variants.blurred, keyBlurred, 'image/webp');
        if (!storedKeyBlurred) {
            await deleteFile(storedKey).catch(() => {});
            return null;
        }

        return { key: storedKey, keyBlurred: storedKeyBlurred };
    } catch (error) {
        if (storedKey) await deleteFile(storedKey).catch(() => {});
        throw error;
    }
}

export async function deleteImagePair(key: string, keyBlurred: string): Promise<void> {
    await Promise.allSettled([deleteFile(key), deleteFile(keyBlurred)]);
}

export async function storeProfilePhotoFromBuffer(userId: string, input: Buffer): Promise<StoredImagePair | null> {
    const key = `photos/${userId}/${crypto.randomUUID()}.webp`;
    const keyBlurred = buildBlurredImageKey(key);
    const variants = await createProfilePhotoVariants(input);
    return uploadImagePair(variants, key, keyBlurred);
}

export async function storeActivityPhotoFromBuffer(activityId: string, input: Buffer): Promise<StoredImagePair | null> {
    const key = `activities/${activityId}/${crypto.randomUUID()}.webp`;
    const keyBlurred = buildBlurredImageKey(key);
    const variants = await createActivityPhotoVariants(input);
    return uploadImagePair(variants, key, keyBlurred);
}
