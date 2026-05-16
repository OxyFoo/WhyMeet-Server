import sharp from 'sharp';

export interface PhotoVariantOptions {
    width: number;
    height: number;
    previewWidth: number;
    previewHeight: number;
    normalQuality: number;
    previewQuality: number;
    blurSigma: number;
}

export interface PhotoImageVariants {
    normal: Buffer;
    blurred: Buffer;
}

const PROFILE_PHOTO_OPTIONS: PhotoVariantOptions = {
    width: 800,
    height: 800,
    previewWidth: 24,
    previewHeight: 24,
    normalQuality: 80,
    previewQuality: 20,
    blurSigma: 32
};

const ACTIVITY_PHOTO_OPTIONS: PhotoVariantOptions = {
    width: 1200,
    height: 800,
    previewWidth: 36,
    previewHeight: 24,
    normalQuality: 80,
    previewQuality: 20,
    blurSigma: 32
};

export function buildBlurredImageKey(key: string): string {
    return key.endsWith('.webp') ? key.replace(/\.webp$/, '.blurred.webp') : `${key}.blurred.webp`;
}

export async function createPhotoImageVariants(
    input: Buffer,
    options: PhotoVariantOptions
): Promise<PhotoImageVariants> {
    const normal = await sharp(input)
        .resize(options.width, options.height, { fit: 'cover', withoutEnlargement: true })
        .webp({ quality: options.normalQuality })
        .toBuffer();

    const blurred = await sharp(input)
        .resize(options.previewWidth, options.previewHeight, { fit: 'cover', withoutEnlargement: true })
        .blur(options.blurSigma)
        .resize(options.width, options.height, { fit: 'cover', kernel: sharp.kernel.cubic })
        .webp({ quality: options.previewQuality, smartSubsample: true })
        .toBuffer();

    return { normal, blurred };
}

export function createProfilePhotoVariants(input: Buffer): Promise<PhotoImageVariants> {
    return createPhotoImageVariants(input, PROFILE_PHOTO_OPTIONS);
}

export function createActivityPhotoVariants(input: Buffer): Promise<PhotoImageVariants> {
    return createPhotoImageVariants(input, ACTIVITY_PHOTO_OPTIONS);
}
