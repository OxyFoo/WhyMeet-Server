import type { PrismaClient } from '@prisma/client';
import { normalizeEmail } from '@/services/emailValidator';

type LoginBypassDatabase = Pick<PrismaClient, 'loginBypassEmail'>;

export async function isLoginBypassEmail(db: LoginBypassDatabase, email: string): Promise<boolean> {
    const normalizedEmail = normalizeEmail(email);
    const row = await db.loginBypassEmail.findUnique({
        where: { email: normalizedEmail },
        select: { id: true }
    });
    return row !== null;
}
