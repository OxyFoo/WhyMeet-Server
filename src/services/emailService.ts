import nodemailer from 'nodemailer';
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

function buildValidationUrl(token: string): string {
    const scheme = env.SSL_PRIVATE_KEY_PATH ? 'https' : 'http';
    const port = env.ENVIRONMENT === 'prod' ? '' : `:${env.LISTEN_PORT_WS}`;
    return `${scheme}://${env.DOMAIN}${port}/auth/validate-email/${encodeURIComponent(token)}`;
}

export async function sendConfirmationEmail(to: string, mailToken: string): Promise<void> {
    const link = buildValidationUrl(mailToken);

    if (!transporter) {
        logger.warn(`[Email] No SMTP configured — validation link: ${link}`);
        return;
    }

    const html = renderTemplate('confirmation-email.html', {
        link,
        ttlMinutes: String(env.MAIL_TOKEN_TTL_MINUTES)
    });

    try {
        await transporter.sendMail({
            from: env.EMAIL_FROM,
            to,
            subject: 'WhyMeet — Confirm your device',
            html
        });
        logger.info(`[Email] Confirmation email sent to ${to}`);
    } catch (error) {
        logger.error(`[Email] Failed to send to ${to}`, error);
    }
}
