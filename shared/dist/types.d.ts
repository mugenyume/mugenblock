export type FilteringMode = 'lite' | 'standard' | 'advanced';
export type NeutralizedCategory = 'NET_BLOCK' | 'COS_HIDE' | 'COS_REMOVE' | 'POP_PREVENT' | 'OVERLAY_FIX' | 'OTHER';
export type NetBlockMode = 'debug_exact' | 'badge_estimate';
export interface NeutralizedCounters {
    netBlock: number;
    cosHide: number;
    cosRemove: number;
    popPrevent: number;
    overlayFix: number;
    other: number;
    weighted: number;
}
export interface NeutralizedStats {
    sessionStartedAt: number;
    global: NeutralizedCounters;
    byDomain: Record<string, NeutralizedCounters>;
    netBlockMode: NetBlockMode;
}
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
export interface StorageSchema {
    settings: {
        mode: FilteringMode;
        enabledRulesets: string[];
        allowRemoteConfig: boolean;
        metricsEnabled: boolean;
    };
    perSite: Record<string, SiteSettings>;
    stats: StatsData;
    schemaVersion: number;
}
export interface StatsData {
    totalBlocked: number;
    cosmeticHides: number;
    heuristicRemovals: number;
    sessions: Record<string, number>;
    neutralized: NeutralizedStats;
}
export interface DomainStatsResponse {
    ok: true;
    domain: string;
    stats: NeutralizedCounters;
    netBlockMode: NetBlockMode;
}
export interface GlobalStatsResponse {
    ok: true;
    stats: NeutralizedCounters;
    netBlockMode: NetBlockMode;
}
export type ExtensionMessage = {
    type: 'GET_MODE';
    domain: string;
} | {
    type: 'SET_MODE';
    domain: string;
    mode: FilteringMode;
} | {
    type: 'GET_STATS';
} | {
    type: 'GET_SITE_CONFIG';
    domain: string;
} | {
    type: 'SET_SITE_TOGGLE';
    domain: string;
    key: keyof Pick<SiteSettings, 'mainWorldOff' | 'cosmeticsOff' | 'siteFixesOff'>;
    value: boolean;
} | {
    type: 'TEMPORARY_RELAX';
    domain: string;
    minutes: number;
} | {
    type: 'REQUEST_PERMISSIONS';
    domain: string;
    granted?: boolean;
} | {
    type: 'RELOAD_RULES';
} | {
    type: 'REPORT_ISSUE';
    domain: string;
    details: string;
} | {
    type: 'SET_SITE_DISABLED';
    domain: string;
    disabled: boolean;
} | {
    type: 'EXPORT_SETTINGS';
} | {
    type: 'IMPORT_SETTINGS';
    data: Partial<StorageSchema>;
} | {
    type: 'CLEAR_SITE_OVERRIDES';
} | {
    type: 'GET_TAB_STATS';
    tabId?: number;
} | {
    type: 'INCREMENT_STATS';
    key: 'totalBlocked' | 'cosmeticHides' | 'heuristicRemovals';
    count: number;
} | {
    type: 'RECORD_NEUTRALIZED';
    domain: string;
    tabId?: number;
    deltas: Partial<Record<NeutralizedCategory, number>>;
} | {
    type: 'GET_DOMAIN_STATS';
    domain: string;
    tabId?: number;
} | {
    type: 'GET_GLOBAL_STATS';
} | {
    type: 'RESET_STATS';
    scope: 'domain' | 'global' | 'all';
    domain?: string;
} | {
    type: 'DEBUG_TOGGLE';
    enabled: boolean;
};
export interface LocalStats {
    cosmeticHides: number;
    heuristicRemovals: number;
    mutationBatches: number;
    maxCallbackMs: number;
    activeTimers: number;
}
export interface CosmeticConfig {
    fastSelectors: string[];
    slowSelectors: string[];
    hideRules: string[];
    siteFixes: SiteFixRecipe[];
}
export interface SiteFixRecipe {
    id: string;
    type: 'DOM_REMOVE' | 'CSS_HIDE' | 'SCRIPTLET';
    params: Record<string, any>;
}
export interface IFilteringBackend {
    enableRuleset(id: string): Promise<void>;
    disableRuleset(id: string): Promise<void>;
    updateDynamicRules(rules: any[]): Promise<void>;
}
export interface RuleMatchFeedback {
    ruleId: number;
    rulesetId: string;
    url: string;
    method: string;
}
export declare const DEFAULT_SITE_SETTINGS: SiteSettings;
export declare const DEFAULT_STATS: StatsData;
export declare const SCHEMA_VERSION = 5;
//# sourceMappingURL=types.d.ts.map