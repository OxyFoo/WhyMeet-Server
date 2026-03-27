import nodemailer from 'nodemailer';
import { env } from '@/config/env';
import { logger } from '@/config/logger';

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

    const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#1a1a1a;">
  <h2 style="color:#6366f1;">WhyMeet</h2>
  <p>Click the button below to confirm your device:</p>
  <a href="${link}" style="display:inline-block;padding:12px 28px;background:#6366f1;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">
    Confirm my device
  </a>
  <p style="margin-top:24px;font-size:13px;color:#888;">
    If you didn't request this, you can safely ignore this email.<br>
    This link expires in ${env.MAIL_TOKEN_TTL_MINUTES} minutes.
  </p>
</body>
</html>`.trim();

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
