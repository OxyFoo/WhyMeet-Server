import disposableDomains from 'disposable-email-domains';

const disposableSet = new Set<string>(disposableDomains);

export function isDisposableEmail(email: string): boolean {
    const domain = email.trim().toLowerCase().split('@')[1];
    if (!domain) return false;
    return disposableSet.has(domain);
}

export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}
