import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type {
    HTTPResponse_SignUp,
    HTTPResponse_SignIn,
    HTTPResponse_RefreshWSToken,
    HTTPResponse_DeviceStatus,
    HTTPResponse_ResendEmail,
    HTTPResponse_SignOut
} from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { tokenManager } from '@/services/tokenManager';
import { mapUserToProfile, profileInclude } from '@/services/userMapper';
import { sendConfirmationEmail } from '@/services/emailService';
import { logger } from '@/config/logger';

export const authRouter = Router();

// ─── Rate limiters ───────────────────────────────────────────────────

const signUpLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, message: 'Too many sign-up attempts, try again later' }
});
const signInLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { status: 'wait-mail', message: 'Too many sign-in attempts, try again later' }
});
const resendLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 3,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, message: 'Too many resend attempts, try again later' }
});
const statusLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });

// ─── Validation schemas ──────────────────────────────────────────────

const signUpSchema = z.object({
    email: z.string().email(),
    deviceUUID: z.string().min(1)
});

const signInSchema = z.object({
    email: z.string().email(),
    deviceUUID: z.string().min(1),
    sessionToken: z.string().optional()
});

const refreshSchema = z.object({
    deviceUUID: z.string().min(1),
    sessionToken: z.string().min(1)
});

const resendSchema = z.object({
    deviceUUID: z.string().min(1)
});

const signOutSchema = z.object({
    deviceUUID: z.string().min(1),
    sessionToken: z.string().min(1)
});

// ─── POST /auth/sign-up ─────────────────────────────────────────────

authRouter.post('/sign-up', signUpLimiter, async (req, res) => {
    const parsed = signUpSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ success: false, message: 'Invalid request' } satisfies HTTPResponse_SignUp);
        return;
    }

    const { email, deviceUUID } = parsed.data;
    const db = getDatabase();

    try {
        // Check if user already exists
        const existing = await db.user.findUnique({ where: { email } });
        if (existing) {
            res.status(409).json({ success: false, message: 'Email already in use' } satisfies HTTPResponse_SignUp);
            return;
        }

        // Create user + profile
        const user = await db.user.create({
            data: {
                email,
                profile: { create: {} }
            }
        });

        // Create device in pending status with mail token
        const sessionToken = tokenManager.session.generate();
        const mailToken = tokenManager.mail.generate(user.id, '');

        const device = await db.device.create({
            data: {
                uuid: deviceUUID,
                sessionTokenHash: tokenManager.hashToken(sessionToken),
                status: 'pending',
                userId: user.id
            }
        });

        // Generate mail token with actual device ID and store its hash
        const realMailToken = tokenManager.mail.generate(user.id, device.id);
        if (realMailToken) {
            await db.device.update({
                where: { id: device.id },
                data: { mailTokenHash: tokenManager.hashToken(realMailToken) }
            });
            await sendConfirmationEmail(email, realMailToken);
        }

        logger.info(`[Auth] Sign-up: user=${user.id}, device=${device.id}, email=${email}`);

        res.json({
            success: true,
            message: 'Check your email to confirm your account',
            sessionToken
        } satisfies HTTPResponse_SignUp);
    } catch (error) {
        logger.error('[Auth] Sign-up error', error);
        res.status(500).json({ success: false, message: 'Internal error' } satisfies HTTPResponse_SignUp);
    }
});

// ─── POST /auth/sign-in ─────────────────────────────────────────────

authRouter.post('/sign-in', signInLimiter, async (req, res) => {
    const parsed = signInSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ status: 'wait-mail', message: 'Invalid request' } satisfies HTTPResponse_SignIn);
        return;
    }

    const { email, deviceUUID, sessionToken } = parsed.data;
    const db = getDatabase();

    try {
        // Find user by email
        const user = await db.user.findUnique({
            where: { email },
            include: profileInclude
        });

        if (!user) {
            res.status(401).json({ status: 'wait-mail', message: 'Invalid credentials' } satisfies HTTPResponse_SignIn);
            return;
        }

        // Find device by UUID and user
        const device = await db.device.findUnique({ where: { uuid: deviceUUID } });

        if (device && device.userId === user.id) {
            // Known device
            if (device.status === 'pending') {
                res.json({
                    status: 'wait-mail',
                    message: 'Please confirm your email first'
                } satisfies HTTPResponse_SignIn);
                return;
            }

            // Active device — verify session token
            if (!sessionToken || !tokenManager.session.check(device.sessionTokenHash, sessionToken)) {
                res.status(401).json({ status: 'wait-mail', message: 'Invalid session' } satisfies HTTPResponse_SignIn);
                return;
            }

            // Cycle session token and generate WS token
            const newSessionToken = await tokenManager.session.cycle(device.id);
            const wsToken = tokenManager.ws.generate(user.id, device.id);

            logger.info(`[Auth] Sign-in: user=${user.id}, device=${device.id}`);

            const response: HTTPResponse_SignIn = {
                status: 'authenticated',
                wsToken,
                newSessionToken,
                user: mapUserToProfile(user)
            };
            res.json(response);
            return;
        }

        // Unknown device for this user — create pending device, send confirmation email
        const newSessionToken = tokenManager.session.generate();
        const newDevice = await db.device.create({
            data: {
                uuid: deviceUUID,
                sessionTokenHash: tokenManager.hashToken(newSessionToken),
                status: 'pending',
                userId: user.id
            }
        });

        const mailToken = tokenManager.mail.generate(user.id, newDevice.id);
        if (mailToken) {
            await db.device.update({
                where: { id: newDevice.id },
                data: { mailTokenHash: tokenManager.hashToken(mailToken) }
            });
            await sendConfirmationEmail(user.email, mailToken);
        }

        logger.info(`[Auth] New device for user=${user.id}, device=${newDevice.id}`);
        res.json({
            status: 'new-device',
            message: 'Check your email to confirm this device'
        } satisfies HTTPResponse_SignIn);
    } catch (error) {
        logger.error('[Auth] Sign-in error', error);
        res.status(500).json({ status: 'wait-mail', message: 'Internal error' } satisfies HTTPResponse_SignIn);
    }
});

// ─── GET /auth/validate-email/:token ─────────────────────────────────

const htmlPage = (title: string, message: string, success: boolean) => `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f8f9fa;color:#1a1a1a;}
.card{text-align:center;padding:48px 32px;background:#fff;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:400px;}
.icon{font-size:48px;margin-bottom:16px;}
h1{font-size:22px;margin:0 0 12px;}
p{color:#666;margin:0;line-height:1.5;}</style></head>
<body><div class="card">
<div class="icon">${success ? '✅' : '❌'}</div>
<h1>${title}</h1>
<p>${message}</p>
</div></body></html>`;

authRouter.get('/validate-email/:token', async (req, res) => {
    const token = req.params.token;
    if (typeof token !== 'string') {
        res.status(400)
            .type('html')
            .send(htmlPage('Invalid Link', 'Missing token.', false));
        return;
    }

    try {
        const result = await tokenManager.mail.confirm(token);
        if (!result) {
            res.status(400)
                .type('html')
                .send(
                    htmlPage(
                        'Invalid Link',
                        'This confirmation link is invalid or has expired. Please request a new one from the app.',
                        false
                    )
                );
            return;
        }

        logger.info(`[Auth] Email validated: user=${result.userId}, device=${result.deviceId}`);
        res.type('html').send(
            htmlPage(
                'Device Confirmed',
                'Your device has been confirmed successfully. You can now return to the app.',
                true
            )
        );
    } catch (error) {
        logger.error('[Auth] Validate email error', error);
        res.status(500)
            .type('html')
            .send(htmlPage('Error', 'An unexpected error occurred. Please try again later.', false));
    }
});

// ─── POST /auth/refresh-ws-token ─────────────────────────────────────

authRouter.post('/refresh-ws-token', async (req, res) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request' });
        return;
    }

    const { deviceUUID, sessionToken } = parsed.data;
    const db = getDatabase();

    try {
        const device = await db.device.findUnique({ where: { uuid: deviceUUID } });
        if (!device || device.status !== 'active' || !device.userId) {
            res.status(401).json({ error: 'Invalid device' });
            return;
        }

        if (!tokenManager.session.check(device.sessionTokenHash, sessionToken)) {
            res.status(401).json({ error: 'Invalid session' });
            return;
        }

        const newSessionToken = await tokenManager.session.cycle(device.id);
        const wsToken = tokenManager.ws.generate(device.userId, device.id);

        logger.info(`[Auth] WS token refreshed: device=${device.id}`);

        const response: HTTPResponse_RefreshWSToken = { wsToken, newSessionToken };
        res.json(response);
    } catch (error) {
        logger.error('[Auth] Refresh WS token error', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ─── GET /auth/device-status/:deviceUUID ─────────────────────────────

authRouter.get('/device-status/:deviceUUID', statusLimiter, async (req, res) => {
    const deviceUUID = req.params.deviceUUID;
    if (typeof deviceUUID !== 'string') {
        res.status(400).json({ status: 'pending' } satisfies HTTPResponse_DeviceStatus);
        return;
    }
    const db = getDatabase();

    try {
        const device = await db.device.findUnique({ where: { uuid: deviceUUID } });
        if (!device) {
            res.status(404).json({ status: 'pending' } satisfies HTTPResponse_DeviceStatus);
            return;
        }

        res.json({ status: device.status as 'pending' | 'active' } satisfies HTTPResponse_DeviceStatus);
    } catch (error) {
        logger.error('[Auth] Device status error', error);
        res.status(500).json({ status: 'pending' } satisfies HTTPResponse_DeviceStatus);
    }
});

// ─── POST /auth/resend-email ─────────────────────────────────────────

authRouter.post('/resend-email', resendLimiter, async (req, res) => {
    const parsed = resendSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ success: false, message: 'Invalid request' } satisfies HTTPResponse_ResendEmail);
        return;
    }

    const { deviceUUID } = parsed.data;
    const db = getDatabase();

    try {
        const device = await db.device.findUnique({
            where: { uuid: deviceUUID },
            include: { user: true }
        });

        if (!device || device.status !== 'pending' || !device.userId || !device.user) {
            res.status(400).json({
                success: false,
                message: 'No pending confirmation for this device'
            } satisfies HTTPResponse_ResendEmail);
            return;
        }

        // Cooldown: 60 seconds since last token generation
        const cooldownMs = 60 * 1000;
        if (Date.now() - device.lastSeenAt.getTime() < cooldownMs) {
            res.status(429).json({
                success: false,
                message: 'Please wait before requesting another email'
            } satisfies HTTPResponse_ResendEmail);
            return;
        }

        // Generate new mail token and store its hash
        const mailToken = tokenManager.mail.generate(device.userId, device.id);
        if (!mailToken) {
            res.status(500).json({
                success: false,
                message: 'Failed to generate token'
            } satisfies HTTPResponse_ResendEmail);
            return;
        }

        await db.device.update({
            where: { id: device.id },
            data: { mailTokenHash: tokenManager.hashToken(mailToken), lastSeenAt: new Date() }
        });

        await sendConfirmationEmail(device.user.email, mailToken);

        logger.info(`[Auth] Resent confirmation email: device=${device.id}`);
        res.json({ success: true, message: 'Confirmation email sent' } satisfies HTTPResponse_ResendEmail);
    } catch (error) {
        logger.error('[Auth] Resend email error', error);
        res.status(500).json({ success: false, message: 'Internal error' } satisfies HTTPResponse_ResendEmail);
    }
});

// ─── POST /auth/sign-out ─────────────────────────────────────────────

authRouter.post('/sign-out', async (req, res) => {
    const parsed = signOutSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ success: false } satisfies HTTPResponse_SignOut);
        return;
    }

    const { deviceUUID, sessionToken } = parsed.data;
    const db = getDatabase();

    try {
        const device = await db.device.findUnique({ where: { uuid: deviceUUID } });
        if (!device || !device.userId) {
            res.status(401).json({ success: false } satisfies HTTPResponse_SignOut);
            return;
        }

        if (!tokenManager.session.check(device.sessionTokenHash, sessionToken)) {
            res.status(401).json({ success: false } satisfies HTTPResponse_SignOut);
            return;
        }

        // Invalidate session by generating a new random hash (device stays "active")
        await db.device.update({
            where: { id: device.id },
            data: { sessionTokenHash: tokenManager.hashToken(crypto.randomUUID()) }
        });

        // Close any active WS connections for this device
        const { getConnectedClients } = await import('./Server');
        for (const client of getConnectedClients().values()) {
            if (client.deviceId === device.id) {
                client.close(4002, 'Signed out');
            }
        }

        logger.info(`[Auth] Sign-out: device=${device.id}`);
        res.json({ success: true } satisfies HTTPResponse_SignOut);
    } catch (error) {
        logger.error('[Auth] Sign-out error', error);
        res.status(500).json({ success: false } satisfies HTTPResponse_SignOut);
    }
});
