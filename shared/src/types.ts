
export type FilteringMode = 'lite' | 'standard' | 'advanced';

export interface SiteSettings {
  mode: FilteringMode;
  hostPermissionGranted: boolean;
  cosmeticEnabled: boolean;
  siteFixesEnabled: boolean;
  mainWorldOff: boolean;
  cosmeticsOff: boolean;
  siteFixesOff: boolean;
  breakageCount: number;
  relaxUntil?: number; // timestamp for temporary relax
}

export interface StorageSchema {
  settings: {
    mode: FilteringMode;
    enabledRulesets: string[];
    allowRemoteConfig: boolean;
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
}

export type ExtensionMessage =
  | { type: 'GET_MODE'; domain: string }
  | { type: 'SET_MODE'; domain: string; mode: FilteringMode }
  | { type: 'GET_STATS' }
  | { type: 'GET_SITE_CONFIG'; domain: string }
  | { type: 'SET_SITE_TOGGLE'; domain: string; key: keyof Pick<SiteSettings, 'mainWorldOff' | 'cosmeticsOff' | 'siteFixesOff'>; value: boolean }
  | { type: 'TEMPORARY_RELAX'; domain: string; minutes: number }
  | { type: 'REQUEST_PERMISSIONS'; domain: string }
  | { type: 'RELOAD_RULES' }
  | { type: 'REPORT_ISSUE'; domain: string; details: string }
  | { type: 'EXPORT_SETTINGS' }
  | { type: 'IMPORT_SETTINGS'; data: Partial<StorageSchema> }
  | { type: 'CLEAR_SITE_OVERRIDES' };

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

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  mode: 'lite',
  hostPermissionGranted: false,
  cosmeticEnabled: false,
  siteFixesEnabled: false,
  mainWorldOff: false,
  cosmeticsOff: false,
  siteFixesOff: false,
  breakageCount: 0,
};

export const DEFAULT_STATS: StatsData = {
  totalBlocked: 0,
  cosmeticHides: 0,
  heuristicRemovals: 0,
  sessions: {},
};

export const SCHEMA_VERSION = 2;
