// Keep in sync with shared/src/types.ts to avoid content script bundling imports.
export type FilteringMode = 'lite' | 'standard' | 'advanced';

export interface SiteSettings {
    mode: FilteringMode;
    hostPermissionGranted: boolean;
    cosmeticEnabled: boolean;
    siteFixesEnabled: boolean;
    disabled: boolean;
    mainWorldOff: boolean;
    cosmeticsOff: boolean;
    siteFixesOff: boolean;
    breakageCount: number;
    lastBreakageAt?: number;
    relaxUntil?: number;
    safeModeUntil?: number;
    pauseCount?: number;
    lastPauseAt?: number;
    frictionScore?: number;
    lastFrictionAt?: number;
}

export interface SiteFixRecipe {
    id: string;
    type: 'DOM_REMOVE' | 'CSS_HIDE' | 'SCRIPTLET';
    params: Record<string, any>;
}

export interface CosmeticConfig {
    fastSelectors: string[];
    slowSelectors: string[];
    hideRules: string[];
    siteFixes: SiteFixRecipe[];
}

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
    mode: 'lite',
    hostPermissionGranted: false,
    cosmeticEnabled: false,
    siteFixesEnabled: false,
    disabled: false,
    mainWorldOff: false,
    cosmeticsOff: false,
    siteFixesOff: false,
    breakageCount: 0,
};
