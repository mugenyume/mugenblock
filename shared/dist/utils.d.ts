import type { FilteringMode, SiteSettings } from './types';
export declare function normalizeDomain(input: string | undefined): string | null;
export declare function hashDomain(domain: string): number;
export declare function resolveEffectiveMode(globalMode: FilteringMode | undefined, siteOverride?: Partial<SiteSettings> | null, now?: number): FilteringMode;
export declare function resolveFeatureFlags(mode: FilteringMode, siteSettings?: Partial<SiteSettings> | null): {
    cosmetics: boolean;
    scriptGuard: boolean;
    mainWorld: boolean;
};
//# sourceMappingURL=utils.d.ts.map