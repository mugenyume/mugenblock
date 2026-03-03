export const DEFAULT_SITE_SETTINGS = {
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
export const DEFAULT_STATS = {
    totalBlocked: 0,
    cosmeticHides: 0,
    heuristicRemovals: 0,
    sessions: {},
    neutralized: {
        sessionStartedAt: Date.now(),
        global: {
            netBlock: 0,
            cosHide: 0,
            cosRemove: 0,
            popPrevent: 0,
            overlayFix: 0,
            other: 0,
            weighted: 0,
        },
        byDomain: {},
        netBlockMode: 'badge_estimate',
    },
};
export const SCHEMA_VERSION = 5;
//# sourceMappingURL=types.js.map