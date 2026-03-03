import type { FilteringMode } from '@mugenblock/shared';

type Substitutions = string | string[];

export function t(key: string, substitutions?: Substitutions): string {
    try {
        if (typeof chrome !== 'undefined' && chrome.i18n?.getMessage) {
            const message = chrome.i18n.getMessage(key, substitutions as any);
            if (message) return message;
        }
    } catch {
        // Ignore i18n lookup failures and fall back to key.
    }
    return key;
}

export function tMode(mode: FilteringMode): string {
    return t(`mode_${mode}`);
}
