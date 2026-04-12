import { getDatabase } from '@/services/database';
import fr from '@/i18n/fr.json';
import en from '@/i18n/en.json';

type NotifKey = keyof typeof fr;

const translations: Record<string, Record<NotifKey, string>> = { fr, en };

export function t(lang: string, key: NotifKey, args?: Record<string, string>): string {
    const dict = translations[lang] ?? translations.fr;
    let str = dict[key];
    if (args) {
        for (const [k, v] of Object.entries(args)) {
            str = str.replaceAll(`{${k}}`, v);
        }
    }
    return str;
}

export async function getUserLanguage(userId: string): Promise<string> {
    const db = getDatabase();
    const settings = await db.settings.findUnique({ where: { userId }, select: { language: true } });
    return settings?.language ?? 'fr';
}
