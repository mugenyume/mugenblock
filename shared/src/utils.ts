
import type { FilteringMode, SiteSettings } from './types';

export function normalizeDomain(input: string | undefined): string | null {
    if (!input || typeof input !== 'string') return null;
    try {
        const raw = input.includes('://') ? input : 'https://' + input;
        const u = new URL(raw);
        const h = u.hostname.toLowerCase();
        if (!h || h.length > 253 || h.includes(' ')) return null;
        return h;
    } catch {
        return null;
    }
}

export function hashDomain(domain: string): number {
    let hash = 0;
    for (let i = 0; i < domain.length; i++) {
        hash = ((hash << 5) - hash + domain.charCodeAt(i)) | 0;
    }
    return hash;
}

export function resolveEffectiveMode(
    globalMode: FilteringMode | undefined,
    siteOverride?: Partial<SiteSettings> | null,
    now = Date.now(),
): FilteringMode {
    const fallbackMode: FilteringMode = globalMode || 'lite';
    if (!siteOverride) return fallbackMode;

    if (siteOverride.disabled) return 'lite';
    if (siteOverride.safeModeUntil && siteOverride.safeModeUntil > now) return 'lite';
    if (siteOverride.relaxUntil && siteOverride.relaxUntil > now) return 'lite';

    const siteMode = siteOverride.mode;
    if (siteMode === 'lite' || siteMode === 'standard' || siteMode === 'advanced') {
        return siteMode;
    }

    return fallbackMode;
}

export function resolveFeatureFlags(mode: FilteringMode, siteSettings?: Partial<SiteSettings> | null): {
    cosmetics: boolean;
    scriptGuard: boolean;
    mainWorld: boolean;
} {
    if (mode === 'lite' || siteSettings?.disabled) {
        return {
            cosmetics: false,
            scriptGuard: false,
            mainWorld: false,
        };
    }

    const cosmetics = !siteSettings?.cosmeticsOff;
    const scriptGuard = mode === 'advanced' && !siteSettings?.siteFixesOff;
    const mainWorld = scriptGuard && !siteSettings?.mainWorldOff;

    return { cosmetics, scriptGuard, mainWorld };
}
