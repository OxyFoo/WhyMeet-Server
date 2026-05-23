import type { PrismaClient } from '@prisma/client';
import { isLoginBypassEmail } from '@/services/loginBypassService';

describe('loginBypassService', () => {
    it('normalizes the email before lookup', async () => {
        const findUnique = jest.fn().mockResolvedValue({ id: 'bypass-1' });
        const db = {
            loginBypassEmail: { findUnique }
        } as unknown as Pick<PrismaClient, 'loginBypassEmail'>;

        await expect(isLoginBypassEmail(db, ' Store-Tester@Example.COM ')).resolves.toBe(true);

        expect(findUnique).toHaveBeenCalledWith({
            where: { email: 'store-tester@example.com' },
            select: { id: true }
        });
    });

    it('returns false when the email is not listed', async () => {
        const db = {
            loginBypassEmail: { findUnique: jest.fn().mockResolvedValue(null) }
        } as unknown as Pick<PrismaClient, 'loginBypassEmail'>;

        await expect(isLoginBypassEmail(db, 'missing@example.com')).resolves.toBe(false);
    });
});
