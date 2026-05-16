import sharp from 'sharp';
import {
    buildBlurredImageKey,
    createActivityPhotoVariants,
    createProfilePhotoVariants
} from '@/services/imageVariants';

describe('image variants', () => {
    it('builds a sibling blurred webp key', () => {
        expect(buildBlurredImageKey('photos/user/photo.webp')).toBe('photos/user/photo.blurred.webp');
        expect(buildBlurredImageKey('photos/user/photo')).toBe('photos/user/photo.blurred.webp');
    });

    it('creates valid profile webp variants', async () => {
        const input = await sharp({
            create: {
                width: 1000,
                height: 1000,
                channels: 3,
                background: '#42A5F5'
            }
        })
            .png()
            .toBuffer();

        const variants = await createProfilePhotoVariants(input);
        const normalMetadata = await sharp(variants.normal).metadata();
        const blurredMetadata = await sharp(variants.blurred).metadata();

        expect(normalMetadata.format).toBe('webp');
        expect(normalMetadata.width).toBe(800);
        expect(normalMetadata.height).toBe(800);
        expect(blurredMetadata.format).toBe('webp');
        expect(blurredMetadata.width).toBe(800);
        expect(blurredMetadata.height).toBe(800);
    });

    it('creates valid activity webp variants', async () => {
        const input = await sharp({
            create: {
                width: 1600,
                height: 1000,
                channels: 3,
                background: '#FF7043'
            }
        })
            .jpeg()
            .toBuffer();

        const variants = await createActivityPhotoVariants(input);
        const normalMetadata = await sharp(variants.normal).metadata();
        const blurredMetadata = await sharp(variants.blurred).metadata();

        expect(normalMetadata.format).toBe('webp');
        expect(normalMetadata.width).toBe(1200);
        expect(normalMetadata.height).toBe(800);
        expect(blurredMetadata.format).toBe('webp');
        expect(blurredMetadata.width).toBe(1200);
        expect(blurredMetadata.height).toBe(800);
    });
});
