import { readFileSync } from 'fs';
import { join } from 'path';

const cache = new Map<string, string>();

function load(name: string): string {
    const cached = cache.get(name);
    if (cached) return cached;

    const content = readFileSync(join(process.cwd(), 'templates', name), 'utf-8');
    cache.set(name, content);
    return content;
}

export function renderTemplate(name: string, vars: Record<string, string>): string {
    let html = load(name);
    for (const [key, value] of Object.entries(vars)) {
        html = html.replaceAll(`{{${key}}}`, value);
    }
    return html;
}
