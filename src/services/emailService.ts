import nodemailer from 'nodemailer';
import { join } from 'path';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { renderTemplate } from '@/services/templateService';
import { getDatabase } from '@/services/database';
import { type EmailTypeKey, type EmailLogStatus, getEmailTypeDescriptor } from '@oxyfoo/whymeet-types';

const transporter = env.SMTP_HOST
    ? nodemailer.createTransport({
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          secure: env.SMTP_PORT === 465,
          auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }
      })
    : null;

export function isSmtpConfigured(): boolean {
    return transporter !== null;
}

function buildValidationUrl(token: string, language: string): string {
    return `${env.PUBLIC_APP_URL}/auth/validate-email/${encodeURIComponent(token)}?lang=${encodeURIComponent(language)}`;
}

// ─── Email i18n ──────────────────────────────────────────────────────

const EMAIL_STRINGS: Record<
    string,
    {
        subject: string;
        heading: string;
        body: string;
        ctaLabel: string;
        expiryNote: (minutes: number) => string;
        footer: string;
    }
> = {
    fr: {
        subject: 'WhyMeet — Confirme ton appareil',
        heading: 'Confirme ton appareil',
        body: 'Une nouvelle tentative de connexion a été effectuée sur ton compte WhyMeet. Clique sur le bouton ci-dessous pour confirmer cet appareil et finaliser ta connexion.',
        ctaLabel: '✓  Confirmer mon appareil',
        expiryNote: (m) =>
            `Ce lien expire dans <strong style="color:#6c63ff">${m} minutes</strong>. Si tu n'es pas à l'origine de cette demande, ignore cet email — ton compte reste en sécurité.`,
        footer: '© 2026 WhyMeet — Tous droits réservés'
    },
    en: {
        subject: 'WhyMeet — Confirm your device',
        heading: 'Confirm your device',
        body: 'A new sign-in attempt was made on your WhyMeet account. Click the button below to confirm this device and complete your login.',
        ctaLabel: '✓  Confirm my device',
        expiryNote: (m) =>
            `This confirmation link expires in <strong style="color:#6c63ff">${m} minutes</strong>. If you did not request this, you can safely ignore this email — your account remains secure.`,
        footer: '© 2026 WhyMeet — All rights reserved'
    }
};

function getEmailStrings(language: string) {
    return EMAIL_STRINGS[language] ?? EMAIL_STRINGS.fr;
}

// ─── Send confirmation email ─────────────────────────────────────────

export async function sendConfirmationEmail(
    to: string,
    mailToken: string,
    language = 'fr',
    recipientUserId?: string | null
): Promise<void> {
    const link = buildValidationUrl(mailToken, language);
    const s = getEmailStrings(language);

    if (!transporter) {
        logger.warn(`[Email] No SMTP configured — validation link: ${link}`);
        return;
    }

    const html = renderTemplate('confirmation-email.html', {
        link,
        ttlMinutes: String(env.MAIL_TOKEN_TTL_MINUTES),
        heading: s.heading,
        body: s.body,
        ctaLabel: s.ctaLabel,
        expiryNote: s.expiryNote(env.MAIL_TOKEN_TTL_MINUTES),
        footer: s.footer
    });

    await sendTrackedMail('auth.device_confirmation', {
        to,
        subject: s.subject,
        html,
        recipientUserId: recipientUserId ?? null,
        attachments: [
            {
                filename: 'logo.png',
                path: join(process.cwd(), 'templates', 'logo.png'),
                cid: 'logo'
            }
        ],
        metadata: { language }
    });
}

// ─── Tracked send (server scope) ─────────────────────────────────────

export type ServerTrackedSendInput = {
    to: string;
    subject: string;
    html: string;
    text?: string;
    recipientUserId?: string | null;
    metadata?: Record<string, unknown>;
    attachments?: Array<{ filename: string; path: string; cid?: string }>;
};

/**
 * Send an email and persist a row in `EmailLog`. Honors the `EmailAutoConfig`
 * toggle for `toggleable` types (skipped row when disabled). Never throws —
 * failures are logged with `status: 'failed'` and the returned status reflects
 * the outcome.
 */
export async function sendTrackedMail(type: EmailTypeKey, input: ServerTrackedSendInput): Promise<EmailLogStatus> {
    const descriptor = getEmailTypeDescriptor(type);
    const db = getDatabase();

    if (descriptor.toggleable) {
        const cfg = await db.emailAutoConfig.findUnique({ where: { type } }).catch(() => null);
        if (cfg && !cfg.enabled) {
            await persistLog(type, input, 'skipped', null);
            return 'skipped';
        }
    }

    if (!transporter) {
        logger.warn(`[Email] No SMTP configured — would have sent ${type} to ${input.to}`);
        await persistLog(type, input, 'skipped', 'smtp_not_configured');
        return 'skipped';
    }

    try {
        await transporter.sendMail({
            from: env.EMAIL_FROM,
            to: input.to,
            subject: input.subject,
            html: input.html,
            text: input.text,
            attachments: input.attachments
        });
        logger.info(`[Email] sent type=${type} to=${input.to}`);
        await persistLog(type, input, 'sent', null);
        return 'sent';
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[Email] Failed type=${type} to=${input.to}: ${message}`);
        await persistLog(type, input, 'failed', message);
        return 'failed';
    }
}

async function persistLog(
    type: EmailTypeKey,
    input: ServerTrackedSendInput,
    status: EmailLogStatus,
    errorMessage: string | null
): Promise<void> {
    try {
        const db = getDatabase();
        await db.emailLog.create({
            data: {
                type,
                recipientEmail: input.to,
                recipientUserId: input.recipientUserId ?? null,
                subject: input.subject,
                status,
                errorMessage,
                metadata: input.metadata ? (input.metadata as object) : undefined,
                sentBy: 'server'
            }
        });
    } catch (e) {
        logger.error('[Email] Failed to persist EmailLog row', e);
    }
}
