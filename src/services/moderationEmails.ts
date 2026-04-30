// ─── Moderation / report email i18n & rendering ──────────────────────
//
// Centralised templates for the automatic emails sent from the Server when
// an account is moderated or a report is acknowledged. Console-side moderation
// emails live in `WhyMeet-Console/src/lib/email.ts` to keep the SMTP boundary
// per-process; only `report.received_ack` is fired from here today.

type Lang = 'fr' | 'en';

function asLang(input?: string | null): Lang {
    return input === 'en' ? 'en' : 'fr';
}

const STYLES = `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.5;color:#18181b;`;

function wrap(body: string, lang: Lang): string {
    const footer =
        lang === 'en'
            ? '© 2026 WhyMeet — Automated message, please do not reply.'
            : '© 2026 WhyMeet — Message automatique, ne pas répondre.';
    return `
<div style="${STYLES}background:#fafafa;padding:32px;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;
       box-shadow:0 2px 8px rgba(0,0,0,0.05);">
    ${body}
    <hr style="border:none;border-top:1px solid #e4e4e7;margin:32px 0 16px;" />
    <p style="margin:0;font-size:12px;color:#71717a;">${footer}</p>
  </div>
</div>`;
}

// ─── report.received_ack ─────────────────────────────────────────────

export function renderReportAck(language?: string | null): { subject: string; html: string } {
    const lang = asLang(language);
    if (lang === 'en') {
        return {
            subject: 'WhyMeet — Your report has been received',
            html: wrap(
                `<h1 style="margin:0 0 16px;font-size:20px;">Report received</h1>
                 <p>We have received your report. Our moderation team will review it and take appropriate action if needed.</p>
                 <p>You will be notified again if a decision is made on the reported account.</p>
                 <p style="font-size:13px;color:#71717a;">Thank you for helping keep WhyMeet safe.</p>`,
                lang
            )
        };
    }
    return {
        subject: 'WhyMeet — Ton signalement a bien été reçu',
        html: wrap(
            `<h1 style="margin:0 0 16px;font-size:20px;">Signalement reçu</h1>
             <p>Nous avons bien reçu ton signalement. Notre équipe de modération va l'examiner et prendre les mesures nécessaires si besoin.</p>
             <p>Tu seras à nouveau notifié si une décision est prise concernant le compte signalé.</p>
             <p style="font-size:13px;color:#71717a;">Merci de contribuer à la sécurité de la communauté WhyMeet.</p>`,
            lang
        )
    };
}

// ─── Helpers exported for tests / future server-scope emails ─────────

export const __test__ = { wrap, asLang };
