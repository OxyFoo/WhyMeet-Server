jest.mock('@/config/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), success: jest.fn() }
}));

import { validatePurchaseReceipt } from '@/services/receiptValidationService';
import { PRODUCT_IDS } from '@oxyfoo/whymeet-types';

const validSubscriptionProduct = PRODUCT_IDS.subscriptions.monthly;
const validBoostProduct = PRODUCT_IDS.boosts.boost_1d;

const baseParams = {
    userId: 'user-1',
    receipt: 'aaaaaaaaaaaaaaaaaaaaaa', // long enough
    platform: 'ios' as const,
    productId: validSubscriptionProduct,
    kind: 'subscription' as const
};

describe('receiptValidationService.validatePurchaseReceipt', () => {
    const ORIGINAL_ENV = { ...process.env };

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it('rejects empty / too-short receipts with invalid_receipt', async () => {
        await expect(validatePurchaseReceipt({ ...baseParams, receipt: '' })).resolves.toMatchObject({
            ok: false,
            code: 'invalid_receipt'
        });
        await expect(validatePurchaseReceipt({ ...baseParams, receipt: 'abc' })).resolves.toMatchObject({
            ok: false,
            code: 'invalid_receipt'
        });
    });

    it('rejects unknown platform', async () => {
        await expect(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            validatePurchaseReceipt({ ...baseParams, platform: 'web' as any })
        ).resolves.toMatchObject({ ok: false, code: 'platform_unavailable' });
    });

    it('rejects unknown product id', async () => {
        await expect(validatePurchaseReceipt({ ...baseParams, productId: 'com.bogus.product' })).resolves.toMatchObject(
            { ok: false, code: 'unknown_product' }
        );
    });

    it('rejects boost product when kind is subscription (and vice versa)', async () => {
        await expect(validatePurchaseReceipt({ ...baseParams, productId: validBoostProduct })).resolves.toMatchObject({
            ok: false,
            code: 'unknown_product'
        });

        await expect(
            validatePurchaseReceipt({
                ...baseParams,
                kind: 'boost',
                productId: validSubscriptionProduct
            })
        ).resolves.toMatchObject({ ok: false, code: 'unknown_product' });
    });

    it('accepts valid receipt in dev mode (non-production NODE_ENV)', async () => {
        process.env.NODE_ENV = 'test';
        delete process.env.IAP_TRUST_CLIENT_RECEIPT;
        const result = await validatePurchaseReceipt(baseParams);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.productId).toBe(validSubscriptionProduct);
            expect(result.transactionId.length).toBeGreaterThan(0);
        }
    });

    it('refuses valid receipt in production without trust flag', async () => {
        process.env.NODE_ENV = 'production';
        delete process.env.IAP_TRUST_CLIENT_RECEIPT;
        await expect(validatePurchaseReceipt(baseParams)).resolves.toMatchObject({
            ok: false,
            code: 'platform_unavailable'
        });
    });

    it('accepts in production when IAP_TRUST_CLIENT_RECEIPT=1', async () => {
        process.env.NODE_ENV = 'production';
        process.env.IAP_TRUST_CLIENT_RECEIPT = '1';
        const result = await validatePurchaseReceipt(baseParams);
        expect(result.ok).toBe(true);
    });

    it('accepts a valid boost receipt', async () => {
        process.env.NODE_ENV = 'test';
        const result = await validatePurchaseReceipt({
            ...baseParams,
            kind: 'boost',
            productId: validBoostProduct
        });
        expect(result.ok).toBe(true);
    });
});
