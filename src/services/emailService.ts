import nodemailer from 'nodemailer';
import { join } from 'path';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { renderTemplate } from '@/services/templateService';

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

export async function sendConfirmationEmail(to: string, mailToken: string, language = 'fr'): Promise<void> {
    const link = buildValidationUrl(mailToken, language);

    if (!transporter) {
        logger.warn(`[Email] No SMTP configured — validation link: ${link}`);
        return;
    }

    const s = getEmailStrings(language);
    const html = renderTemplate('confirmation-email.html', {
        link,
        ttlMinutes: String(env.MAIL_TOKEN_TTL_MINUTES),
        heading: s.heading,
        body: s.body,
        ctaLabel: s.ctaLabel,
        expiryNote: s.expiryNote(env.MAIL_TOKEN_TTL_MINUTES),
        footer: s.footer
    });

    try {
        await transporter.sendMail({
            from: env.EMAIL_FROM,
            to,
            subject: s.subject,
            html,
            attachments: [
                {
                    filename: 'logo.png',
                    path: join(process.cwd(), 'templates', 'logo.png'),
                    cid: 'logo'
                }
            ]
        });
        logger.info(`[Email] Confirmation email sent to ${to} (lang=${language})`);
    } catch (error) {
        logger.error(`[Email] Failed to send to ${to}`, error);
    }
}

// ─── Generic send (used by the admin console) ───────────────────────

export async function sendArbitraryEmail(to: string, subject: string, html: string): Promise<void> {
    if (!transporter) {
        logger.warn(`[Email] No SMTP configured — email to ${to} dropped (subject: ${subject})`);
        return;
    }
    await transporter.sendMail({ from: env.EMAIL_FROM, to, subject, html });
    logger.info(`[Email] Arbitrary email sent to ${to} (subject: ${subject})`);
}
