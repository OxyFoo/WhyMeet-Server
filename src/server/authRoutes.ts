import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type {
    HTTPResponse_Device,
    HTTPResponse_Enter,
    HTTPResponse_GoogleSignIn,
    HTTPResponse_AppleSignIn,
    HTTPResponse_RefreshWSToken,
    HTTPResponse_DeviceStatus,
    HTTPResponse_ResendEmail,
    HTTPResponse_SignOut,
    HTTPResponse_IntegrityChallenge,
    HTTPResponse_IntegrityVerify,
    HTTPResponse_AppealSuspension
} from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { tokenManager } from '@/services/tokenManager';
import { mapUserToProfile, profileInclude } from '@/services/userMapper';
import { sendConfirmationEmail, isSmtpConfigured } from '@/services/emailService';
import { getUserLanguage } from '@/services/notifI18n';
import { renderTemplate } from '@/services/templateService';
import { logger } from '@/config/logger';
import { env } from '@/config/env';
import { isDisposableEmail, normalizeEmail } from '@/services/emailValidator';
import {
    generateChallenge,
    consumeChallenge,
    verifyPlayIntegrity,
    verifyAppAttest,
    isIntegrityCheckEnabled
} from '@/services/integrityService';

export const authRouter = Router();

// ─── Rate limiters ───────────────────────────────────────────────────

const deviceLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false
});
const enterLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false
});
const oauthLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false
});
const resendLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 3,
    standardHeaders: 'draft-8',
    legacyHeaders: false
});
const statusLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false
});
const refreshLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false
});

// ─── Validation schemas ──────────────────────────────────────────────

const deviceSchema = z.object({
    uuid: z.string().uuid().optional(),
    sessionToken: z.string().min(1).optional(),
    name: z.string().max(128).optional(),
    os: z.string().max(64).optional()
});

const enterSchema = z.object({
    email: z.string().email(),
    deviceUUID: z.string().uuid(),
    sessionToken: z.string().min(1),
    username: z.string().min(2).max(32).optional(),
    language: z.string().min(2).max(10).optional()
});

const googleSignInSchema = z.object({
    idToken: z.string().min(1),
    deviceUUID: z.string().uuid()
});

const appleSignInSchema = z.object({
    idToken: z.string().min(1),
    deviceUUID: z.string().uuid()
});

const refreshSchema = z.object({
    deviceUUID: z.string().uuid(),
    sessionToken: z.string().min(1)
});

const resendSchema = z.object({
    deviceUUID: z.string().uuid(),
    sessionToken: z.string().min(1)
});

const signOutSchema = z.object({
    deviceUUID: z.string().uuid(),
    sessionToken: z.string().min(1)
});

// ─── Helpers ─────────────────────────────────────────────────────────

async function linkDeviceAndSendMail(
    userId: string,
    deviceId: string,
    email: string,
    language?: string
): Promise<boolean> {
    const db = getDatabase();

    // If SMTP is not configured, auto-activate the device (skip email verification)
    if (!isSmtpConfigured()) {
        await db.device.update({
            where: { id: deviceId },
            data: { userId, status: 'active' }
        });
        logger.warn(`[Auth] SMTP not configured — device ${deviceId} auto-activated for user ${userId}`);
        return true; // emailSkipped
    }

    const mailToken = tokenManager.mail.generate(userId, deviceId);
    if (mailToken) {
        await db.device.update({
            where: { id: deviceId },
            data: {
                userId,
                status: 'pending',
                mailTokenHash: tokenManager.hashToken(mailToken),
                lastSeenAt: new Date()
            }
        });
        const lang = language ?? (await getUserLanguage(userId));
        await sendConfirmationEmail(email, mailToken, lang);
    }
    return false; // emailSkipped = false
}

// ─── POST /auth/device ──────────────────────────────────────────────
// Transparent device auth at app startup.
// - No uuid → create new orphan device, return uuid + sessionToken
// - uuid + sessionToken → verify, cycle session, return newSessionToken

authRouter.post('/device', deviceLimiter, async (req, res) => {
    const parsed = deviceSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request' });
        return;
    }

    const { uuid, sessionToken, name, os } = parsed.data;
    const db = getDatabase();

    try {
        // New device
        if (!uuid) {
            const newUuid = crypto.randomUUID();
            const newSessionToken = tokenManager.session.generate();
            await db.device.create({
                data: {
                    uuid: newUuid,
                    sessionTokenHash: tokenManager.hashToken(newSessionToken),
                    status: 'pending',
                    name: name ?? '',
                    os: os ?? ''
                }
            });

            logger.info(`[Auth] New device created: uuid=${newUuid}`);
            const response: HTTPResponse_Device = { status: 'new', uuid: newUuid, sessionToken: newSessionToken };
            res.json(response);
            return;
        }

        // Returning device
        if (!sessionToken) {
            res.status(400).json({ error: 'Session token required for existing device' });
            return;
        }

        const device = await db.device.findUnique({ where: { uuid } });
        if (!device) {
            res.status(404).json({ error: 'Unknown device' });
            return;
        }

        if (!tokenManager.session.check(device.sessionTokenHash, sessionToken)) {
            res.status(401).json({ error: 'Invalid session' });
            return;
        }

        const newSessionToken = await tokenManager.session.cycle(device.id);

        // Refresh name/os if mobile reported them (and they changed)
        if ((name && name !== device.name) || (os && os !== device.os)) {
            await db.device.update({
                where: { id: device.id },
                data: {
                    ...(name && name !== device.name ? { name } : {}),
                    ...(os && os !== device.os ? { os } : {})
                }
            });
        }

        logger.debug(`[Auth] Device returning: uuid=${uuid}`);
        const response: HTTPResponse_Device = { status: 'returning', newSessionToken };
        res.json(response);
    } catch (error) {
        logger.error('[Auth] Device error', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ─── POST /auth/enter ───────────────────────────────────────────────
// Merged login + signup flow.
// 1) { email, deviceUUID }            → check if account exists
//    - No account                     → { status: 'no-account' }
//    - Account + device active+valid  → { status: 'authenticated', ... }
//    - Account + device new/pending   → send mail → { status: 'wait-mail' }
// 2) { email, deviceUUID, username }  → create account + link device + send mail → { status: 'wait-mail' }

authRouter.post('/enter', enterLimiter, async (req, res) => {
    const parsed = enterSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request' });
        return;
    }

    const { email: rawEmail, deviceUUID, sessionToken, username, language } = parsed.data;
    const email = normalizeEmail(rawEmail);
    const db = getDatabase();

    // Block disposable / temporary email providers
    if (isDisposableEmail(email)) {
        res.status(422).json({ error: 'disposable_email' });
        return;
    }

    try {
        const device = await db.device.findUnique({ where: { uuid: deviceUUID } });
        if (!device) {
            res.status(404).json({ error: 'Unknown device. Call POST /auth/device first.' });
            return;
        }

        if (!tokenManager.session.check(device.sessionTokenHash, sessionToken)) {
            res.status(401).json({ error: 'Invalid session' });
            return;
        }

        const existingUser = await db.user.findUnique({
            where: { email },
            include: profileInclude
        });

        // ── Account exists ───────────────────────────────────────────
        if (existingUser) {
            // If username was provided but account exists, ignore username (account already created)
            const existingDevice = await db.device.findFirst({
                where: { userId: existingUser.id, uuid: deviceUUID }
            });

            if (existingDevice && existingDevice.status === 'active') {
                // Device already active → authenticate directly
                const newSessionToken = await tokenManager.session.cycle(existingDevice.id);
                const wsToken = tokenManager.ws.generate(existingUser.id, existingDevice.id);

                logger.info(`[Auth] Enter authenticated: user=${existingUser.id}, device=${existingDevice.id}`);
                const response: HTTPResponse_Enter = {
                    status: 'authenticated',
                    wsToken,
                    newSessionToken,
                    user: mapUserToProfile(existingUser)
                };
                res.json(response);
                return;
            }

            // Device not yet linked to this user, or pending → link & send mail
            const emailSkipped = await linkDeviceAndSendMail(existingUser.id, device.id, existingUser.email);

            if (emailSkipped) {
                // SMTP not configured → authenticate directly
                const newSessionToken = await tokenManager.session.cycle(device.id);
                const wsToken = tokenManager.ws.generate(existingUser.id, device.id);

                logger.info(`[Auth] Enter authenticated (email skipped): user=${existingUser.id}, device=${device.id}`);
                const response: HTTPResponse_Enter = {
                    status: 'authenticated',
                    wsToken,
                    newSessionToken,
                    user: mapUserToProfile(existingUser)
                };
                res.json(response);
                return;
            }

            logger.info(`[Auth] Enter wait-mail: user=${existingUser.id}, device=${device.id}`);
            const response: HTTPResponse_Enter = {
                status: 'wait-mail',
                message: 'Check your email to confirm this device'
            };
            res.json(response);
            return;
        }

        // ── No account ──────────────────────────────────────────────
        if (!username) {
            const response: HTTPResponse_Enter = { status: 'no-account' };
            res.json(response);
            return;
        }

        // ── Create account ──────────────────────────────────────────
        const newUser = await db.user.create({
            data: {
                email,
                name: username,
                profile: { create: { spokenLanguages: ['fr'] } }
            }
        });

        // Initialize token balance and swipe quota for new user
        const nextMidnight = new Date();
        nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
        nextMidnight.setUTCHours(0, 0, 0, 0);
        await Promise.all([
            db.tokenBalance.create({
                data: { userId: newUser.id, tokens: env.INITIAL_TOKEN_COUNT, lastRefillAt: new Date() }
            }),
            db.swipeQuota.create({ data: { userId: newUser.id, swipesUsed: 0, resetAt: nextMidnight } })
        ]);

        const emailSkippedSignup = await linkDeviceAndSendMail(newUser.id, device.id, email, language);

        if (emailSkippedSignup) {
            // SMTP not configured → authenticate directly after sign-up
            const newUserFull = await db.user.findUnique({
                where: { id: newUser.id },
                include: profileInclude
            });
            const newSessionToken = await tokenManager.session.cycle(device.id);
            const wsToken = tokenManager.ws.generate(newUser.id, device.id);

            logger.info(`[Auth] Enter sign-up authenticated (email skipped): user=${newUser.id}, device=${device.id}`);
            const response: HTTPResponse_Enter = {
                status: 'authenticated',
                wsToken,
                newSessionToken,
                user: mapUserToProfile(newUserFull!)
            };
            res.json(response);
            return;
        }

        logger.info(`[Auth] Enter sign-up: user=${newUser.id}, device=${device.id}, email=${email}`);
        const response: HTTPResponse_Enter = {
            status: 'wait-mail',
            message: 'Check your email to confirm your account'
        };
        res.json(response);
    } catch (error) {
        logger.error('[Auth] Enter error', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ─── POST /auth/google-signin ────────────────────────────────────────

authRouter.post('/google-signin', oauthLimiter, async (req, res) => {
    const parsed = googleSignInSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request' });
        return;
    }

    if (!env.GOOGLE_CLIENT_ID) {
        res.status(503).json({ error: 'Google Sign-In not configured' });
        return;
    }

    const { idToken, deviceUUID } = parsed.data;
    const db = getDatabase();

    try {
        // Dynamically import to avoid hard dependency when not configured
        const { OAuth2Client } = await import('google-auth-library');
        const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID);

        const ticket = await googleClient.verifyIdToken({
            idToken,
            audience: env.GOOGLE_CLIENT_ID
        });

        const payload = ticket.getPayload();
        if (!payload?.email || !payload.email_verified) {
            res.status(401).json({ error: 'Invalid Google token or unverified email' });
            return;
        }

        const device = await db.device.findUnique({ where: { uuid: deviceUUID } });
        if (!device) {
            res.status(404).json({ error: 'Unknown device. Call POST /auth/device first.' });
            return;
        }

        const user = await db.user.findUnique({
            where: { email: payload.email },
            include: profileInclude
        });

        if (!user) {
            const response: HTTPResponse_GoogleSignIn = { status: 'no-account', email: payload.email };
            res.json(response);
            return;
        }

        // Google verified email → auto-activate device for this user
        await db.device.update({
            where: { id: device.id },
            data: { userId: user.id, status: 'active', mailTokenHash: null }
        });

        const newSessionToken = await tokenManager.session.cycle(device.id);
        const wsToken = tokenManager.ws.generate(user.id, device.id);

        logger.info(`[Auth] Google sign-in: user=${user.id}, device=${device.id}`);
        const response: HTTPResponse_GoogleSignIn = {
            status: 'authenticated',
            wsToken,
            newSessionToken,
            user: mapUserToProfile(user)
        };
        res.json(response);
    } catch (error) {
        logger.error('[Auth] Google sign-in error', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ─── POST /auth/apple-signin ─────────────────────────────────────────

authRouter.post('/apple-signin', oauthLimiter, async (req, res) => {
    const parsed = appleSignInSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request' });
        return;
    }

    if (!env.APPLE_CLIENT_ID) {
        res.status(503).json({ error: 'Apple Sign-In not configured' });
        return;
    }

    const { idToken, deviceUUID } = parsed.data;
    const db = getDatabase();

    try {
        const appleSignin = await import('apple-signin-auth');
        const applePayload = await appleSignin.default.verifyIdToken(idToken, {
            audience: env.APPLE_CLIENT_ID,
            ignoreExpiration: false
        });

        if (!applePayload.email || !applePayload.email_verified) {
            res.status(401).json({ error: 'Invalid Apple token or unverified email' });
            return;
        }

        const device = await db.device.findUnique({ where: { uuid: deviceUUID } });
        if (!device) {
            res.status(404).json({ error: 'Unknown device. Call POST /auth/device first.' });
            return;
        }

        const user = await db.user.findUnique({
            where: { email: applePayload.email },
            include: profileInclude
        });

        if (!user) {
            const response: HTTPResponse_AppleSignIn = { status: 'no-account', email: applePayload.email };
            res.json(response);
            return;
        }

        // Apple verified email → auto-activate device for this user
        await db.device.update({
            where: { id: device.id },
            data: { userId: user.id, status: 'active', mailTokenHash: null }
        });

        const newSessionToken = await tokenManager.session.cycle(device.id);
        const wsToken = tokenManager.ws.generate(user.id, device.id);

        logger.info(`[Auth] Apple sign-in: user=${user.id}, device=${device.id}`);
        const response: HTTPResponse_AppleSignIn = {
            status: 'authenticated',
            wsToken,
            newSessionToken,
            user: mapUserToProfile(user)
        };
        res.json(response);
    } catch (error) {
        logger.error('[Auth] Apple sign-in error', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ─── GET /auth/validate-email/:token ─────────────────────────────────

const STATUS_STRINGS: Record<
    string,
    {
        invalidLink: { title: string; message: string };
        missingToken: { title: string; message: string };
        confirmed: { title: string; message: string };
        error: { title: string; message: string };
        footer: string;
    }
> = {
    fr: {
        invalidLink: {
            title: 'Lien invalide',
            message: "Ce lien de confirmation est invalide ou a expiré. Demande-en un nouveau depuis l'application."
        },
        missingToken: { title: 'Lien invalide', message: 'Token manquant.' },
        confirmed: {
            title: 'Appareil confirmé',
            message: "Ton appareil a été confirmé avec succès. Tu peux maintenant retourner dans l'application."
        },
        error: { title: 'Erreur', message: "Une erreur inattendue s'est produite. Réessaie plus tard." },
        footer: '© 2026 WhyMeet — Tous droits réservés'
    },
    en: {
        invalidLink: {
            title: 'Invalid Link',
            message: 'This confirmation link is invalid or has expired. Please request a new one from the app.'
        },
        missingToken: { title: 'Invalid Link', message: 'Missing token.' },
        confirmed: {
            title: 'Device Confirmed',
            message: 'Your device has been confirmed successfully. You can now return to the app.'
        },
        error: { title: 'Error', message: 'An unexpected error occurred. Please try again later.' },
        footer: '© 2026 WhyMeet — All rights reserved'
    }
};

const statusPage = (title: string, message: string, success: boolean, lang = 'en', footer = STATUS_STRINGS.en.footer) =>
    renderTemplate('status-page.html', { title, message, icon: success ? '✅' : '❌', lang, footer });

authRouter.get('/validate-email/:token', async (req, res) => {
    const token = req.params.token;
    const rawLang = typeof req.query.lang === 'string' ? req.query.lang : 'en';
    const lang = rawLang in STATUS_STRINGS ? rawLang : 'en';
    const s = STATUS_STRINGS[lang];

    if (typeof token !== 'string') {
        res.status(400)
            .type('html')
            .send(statusPage(s.missingToken.title, s.missingToken.message, false, lang, s.footer));
        return;
    }

    try {
        const result = await tokenManager.mail.confirm(token);
        if (!result) {
            res.status(400)
                .type('html')
                .send(statusPage(s.invalidLink.title, s.invalidLink.message, false, lang, s.footer));
            return;
        }

        logger.info(`[Auth] Email validated: user=${result.userId}, device=${result.deviceId}`);
        res.type('html').send(statusPage(s.confirmed.title, s.confirmed.message, true, lang, s.footer));
    } catch (error) {
        logger.error('[Auth] Validate email error', error);
        res.status(500)
            .type('html')
            .send(statusPage(s.error.title, s.error.message, false, lang, s.footer));
    }
});

// ─── POST /auth/refresh-ws-token ─────────────────────────────────────

authRouter.post('/refresh-ws-token', refreshLimiter, async (req, res) => {
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

        const sessionOk = tokenManager.session.check(device.sessionTokenHash, sessionToken);
        if (!sessionOk) {
            res.status(401).json({ error: 'Invalid session' });
            return;
        }

        const user = await db.user.findUnique({
            where: { id: device.userId },
            include: profileInclude
        });
        if (!user) {
            res.status(401).json({ error: 'User not found' });
            return;
        }

        // `deleted` users cannot refresh.
        // `banned`/`suspended` users still get a fresh token + their profile
        // (with `banned`/`suspended` flags set) so the mobile app can route to
        // the dedicated banned/suspended screens instead of bouncing to login.
        if (user.deleted) {
            res.status(403).json({ error: 'Account unavailable' });
            return;
        }

        // Require device integrity verification if enabled
        if (isIntegrityCheckEnabled() && !device.integrityVerifiedAt) {
            res.status(403).json({ error: 'integrity_required' });
            return;
        }

        const newSessionToken = await tokenManager.session.cycle(device.id);
        const wsToken = tokenManager.ws.generate(device.userId, device.id);

        logger.info(`[Auth] WS token refreshed: device=${device.id}`);

        const response: HTTPResponse_RefreshWSToken = { wsToken, newSessionToken, user: mapUserToProfile(user) };
        res.json(response);
    } catch (error) {
        logger.error('[Auth] Refresh WS token error', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ─── GET /auth/device-status/:deviceUUID ─────────────────────────────

authRouter.get('/device-status/:deviceUUID', statusLimiter, async (req, res) => {
    const { deviceUUID } = req.params;
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

    const { deviceUUID, sessionToken } = parsed.data;
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

        if (!tokenManager.session.check(device.sessionTokenHash, sessionToken)) {
            res.status(401).json({ success: false, message: 'Invalid session' } satisfies HTTPResponse_ResendEmail);
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

        const lang = await getUserLanguage(device.userId);
        await sendConfirmationEmail(device.user.email, mailToken, lang);

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
        const { getConnectedClients } = await import('./Server.js');
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

// ─── POST /auth/integrity-challenge ──────────────────────────────────

const challengeSchema = z.object({
    deviceUUID: z.string().min(1),
    sessionToken: z.string().min(1)
});

authRouter.post('/integrity-challenge', refreshLimiter, async (req, res) => {
    if (!isIntegrityCheckEnabled()) {
        res.json({ challenge: null, required: false } satisfies HTTPResponse_IntegrityChallenge);
        return;
    }

    const parsed = challengeSchema.safeParse(req.body);
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

        // If already verified recently (within 24h), skip
        if (device.integrityVerifiedAt && Date.now() - device.integrityVerifiedAt.getTime() < 24 * 60 * 60 * 1000) {
            res.json({ challenge: null, required: false } satisfies HTTPResponse_IntegrityChallenge);
            return;
        }

        const challenge = generateChallenge(device.id);
        res.json({ challenge, required: true } satisfies HTTPResponse_IntegrityChallenge);
    } catch (error) {
        logger.error('[Auth] Integrity challenge error', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ─── POST /auth/integrity-verify ─────────────────────────────────────

const verifyIntegritySchema = z.object({
    deviceUUID: z.string().min(1),
    sessionToken: z.string().min(1),
    platform: z.enum(['android', 'ios']),
    challenge: z.string().min(1),
    token: z.string().min(1),
    keyId: z.string().optional() // Required for iOS App Attest
});

authRouter.post('/integrity-verify', refreshLimiter, async (req, res) => {
    if (!isIntegrityCheckEnabled()) {
        res.json({ verified: true } satisfies HTTPResponse_IntegrityVerify);
        return;
    }

    const parsed = verifyIntegritySchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request' });
        return;
    }

    const { deviceUUID, sessionToken, platform, challenge, token, keyId } = parsed.data;
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

        // Consume the challenge (one-time use)
        if (!consumeChallenge(challenge, device.id)) {
            res.status(400).json({ error: 'Invalid or expired challenge' });
            return;
        }

        let verified = false;

        if (platform === 'android') {
            verified = await verifyPlayIntegrity(token, challenge);
        } else if (platform === 'ios') {
            if (!keyId) {
                res.status(400).json({ error: 'keyId required for iOS' });
                return;
            }
            verified = await verifyAppAttest(token, challenge, keyId);
        }

        if (verified) {
            await db.device.update({
                where: { id: device.id },
                data: { integrityVerifiedAt: new Date() }
            });
            logger.info(`[Auth] Integrity verified: device=${device.id} platform=${platform}`);
        } else {
            logger.warn(`[Auth] Integrity verification failed: device=${device.id} platform=${platform}`);
        }

        res.json({ verified } satisfies HTTPResponse_IntegrityVerify);
    } catch (error) {
        logger.error('[Auth] Integrity verify error', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ─── POST /auth/appeal ───────────────────────────────────────────────
// Submit a suspension appeal. Requires device credentials (no WS needed).
// The account must be suspended; banned/deleted accounts are rejected.

const appealLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000, // 24 h
    limit: 3,
    standardHeaders: 'draft-8',
    legacyHeaders: false
});

const appealSchema = z.object({
    deviceUUID: z.string().uuid(),
    sessionToken: z.string().min(1),
    message: z.string().max(500).optional()
});

authRouter.post('/appeal', appealLimiter, async (req, res) => {
    const parsed = appealSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request' } satisfies HTTPResponse_AppealSuspension);
        return;
    }

    const { deviceUUID, sessionToken, message } = parsed.data;
    const db = getDatabase();

    try {
        const device = await db.device.findUnique({ where: { uuid: deviceUUID } });
        if (!device || !device.userId) {
            res.status(401).json({ error: 'Invalid device' } satisfies HTTPResponse_AppealSuspension);
            return;
        }

        if (!tokenManager.session.check(device.sessionTokenHash, sessionToken)) {
            res.status(401).json({ error: 'Invalid session' } satisfies HTTPResponse_AppealSuspension);
            return;
        }

        const user = await db.user.findUnique({
            where: { id: device.userId },
            select: { suspended: true, banned: true, deleted: true, appealRequestedAt: true }
        });

        if (!user || user.banned || user.deleted) {
            res.status(403).json({
                error: 'Account is not eligible for appeal'
            } satisfies HTTPResponse_AppealSuspension);
            return;
        }

        if (!user.suspended) {
            res.status(409).json({ error: 'Account is not suspended' } satisfies HTTPResponse_AppealSuspension);
            return;
        }

        if (user.appealRequestedAt) {
            res.status(409).json({ error: 'Appeal already submitted' } satisfies HTTPResponse_AppealSuspension);
            return;
        }

        await db.user.update({
            where: { id: device.userId },
            data: {
                appealMessage: message ?? null,
                appealRequestedAt: new Date()
            }
        });

        logger.info(`[Moderation] User ${device.userId} appealed suspension via HTTP`);
        res.json({ success: true } satisfies HTTPResponse_AppealSuspension);
    } catch (error) {
        logger.error('[Auth] Appeal error', error);
        res.status(500).json({ error: 'Internal error' } satisfies HTTPResponse_AppealSuspension);
    }
});
