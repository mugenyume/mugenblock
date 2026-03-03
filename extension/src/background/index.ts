import {
    StorageSchema,
    FilteringMode,
    ExtensionMessage,
    StatsData,
    SiteSettings,
    NeutralizedCategory,
    NeutralizedCounters,
    NeutralizedStats,
    DEFAULT_SITE_SETTINGS,
    DEFAULT_STATS,
    SCHEMA_VERSION,
    normalizeDomain,
    hashDomain,
} from '@mugenblock/shared';

declare const __MUGEN_DEBUG__: boolean;

const UPDATE_ALARM_NAME = 'mugen-update';
const BASE_ALARM_MINUTES = 720;
const JITTER_MINUTES = 15;

const SETTINGS_DEBOUNCE_MS = 1_500;
const STATS_FLUSH_DEBOUNCE_MS = 30_000;
const STATS_MIN_FLUSH_INTERVAL_MS = 30_000;
const UI_STATS_FLUSH_MIN_INTERVAL_MS = 5_000;

const MAX_PER_SITE_ENTRIES = 500;
const MAX_IMPORT_BYTES = 1_000_000;
const MAX_REPORT_DETAILS_LENGTH = 512;
const MAX_STATS_INCREMENT = 2_000;
const MAX_DOMAIN_STATS_ENTRIES = 1_000;

const BREAKAGE_WINDOW_MS = 30 * 60_000;
const SAFE_MODE_MINUTES = 30;

const RELAX_RULE_ID_BASE = 900_000;
const SITE_BYPASS_RULE_ID_BASE = 1_900_000;
const RULE_ID_SPAN = 400_000;

const LAST_KNOWN_GOOD_KEY = '_lastKnownGood';
const METRICS_KEY = '_metrics';

const VALID_MODES: ReadonlySet<FilteringMode> = new Set(['lite', 'standard', 'advanced']);
const VALID_TOGGLES: ReadonlySet<keyof Pick<SiteSettings, 'mainWorldOff' | 'cosmeticsOff' | 'siteFixesOff'>> = new Set([
    'mainWorldOff',
    'cosmeticsOff',
    'siteFixesOff',
]);
const VALID_STATS_KEYS: ReadonlySet<'totalBlocked' | 'cosmeticHides' | 'heuristicRemovals'> = new Set([
    'totalBlocked',
    'cosmeticHides',
    'heuristicRemovals',
]);
const VALID_NEUTRALIZED_CATEGORIES: ReadonlySet<NeutralizedCategory> = new Set([
    'NET_BLOCK',
    'COS_HIDE',
    'COS_REMOVE',
    'POP_PREVENT',
    'OVERLAY_FIX',
    'OTHER',
]);

const NEUTRALIZED_WEIGHTS: Readonly<Record<NeutralizedCategory, number>> = {
    NET_BLOCK: 1,
    COS_HIDE: 0.6,
    COS_REMOVE: 1,
    POP_PREVENT: 1.2,
    OVERLAY_FIX: 0.8,
    OTHER: 0.5,
};
const ALL_RULESETS = [
    'ruleset_core',
    'ruleset_easylist',
    'ruleset_privacy',
    'ruleset_easyprivacy',
    'ruleset_peterlowe',
];

const REQUEST_RESOURCE_TYPES = [
    'main_frame',
    'sub_frame',
    'stylesheet',
    'script',
    'image',
    'font',
    'object',
    'xmlhttprequest',
    'ping',
    'csp_report',
    'media',
    'websocket',
    'webtransport',
    'webbundle',
    'other',
] as chrome.declarativeNetRequest.ResourceType[];

const NON_MAIN_FRAME_RESOURCE_TYPES = REQUEST_RESOURCE_TYPES.filter((resource) => resource !== 'main_frame');

type ParsedMessage =
    | { ok: true; message: ExtensionMessage }
    | {
          ok: false;
          error:
              | 'INVALID_SCHEMA'
              | 'UNKNOWN_TYPE'
              | 'INVALID_DOMAIN'
              | 'INVALID_MODE'
              | 'INVALID_TOGGLE'
              | 'INVALID_PARAMS'
              | 'PAYLOAD_TOO_LARGE';
      };

interface RuntimeMetrics {
    swWakeups: number;
    storageWritesSettings: number;
    storageWritesStats: number;
    messageRejects: number;
}

const DEFAULT_SETTINGS: StorageSchema = {
    settings: {
        mode: 'lite',
        enabledRulesets: [...ALL_RULESETS],
        allowRemoteConfig: false,
        metricsEnabled: false,
    },
    perSite: {},
    stats: sanitizeStats(DEFAULT_STATS),
    schemaVersion: SCHEMA_VERSION,
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBoolean(value: unknown): value is boolean {
    return typeof value === 'boolean';
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
    return Number.isInteger(value) && isFiniteNumber(value) && value >= min && value <= max;
}

function toNonNegativeInt(value: unknown, fallback = 0): number {
    if (!isFiniteNumber(value)) return fallback;
    return Math.max(0, Math.floor(value));
}

function createEmptyCounters(): NeutralizedCounters {
    return {
        netBlock: 0,
        cosHide: 0,
        cosRemove: 0,
        popPrevent: 0,
        overlayFix: 0,
        other: 0,
        weighted: 0,
    };
}

function refreshWeighted(counters: NeutralizedCounters): void {
    counters.weighted = Math.round(
        counters.netBlock * NEUTRALIZED_WEIGHTS.NET_BLOCK +
            counters.cosHide * NEUTRALIZED_WEIGHTS.COS_HIDE +
            counters.cosRemove * NEUTRALIZED_WEIGHTS.COS_REMOVE +
            counters.popPrevent * NEUTRALIZED_WEIGHTS.POP_PREVENT +
            counters.overlayFix * NEUTRALIZED_WEIGHTS.OVERLAY_FIX +
            counters.other * NEUTRALIZED_WEIGHTS.OTHER,
    );
}

function cloneCounters(counters: NeutralizedCounters): NeutralizedCounters {
    return {
        netBlock: counters.netBlock,
        cosHide: counters.cosHide,
        cosRemove: counters.cosRemove,
        popPrevent: counters.popPrevent,
        overlayFix: counters.overlayFix,
        other: counters.other,
        weighted: counters.weighted,
    };
}

function sanitizeNeutralizedCounters(raw: unknown): NeutralizedCounters {
    if (!isRecord(raw)) return createEmptyCounters();
    const counters: NeutralizedCounters = {
        netBlock: toNonNegativeInt(raw.netBlock),
        cosHide: toNonNegativeInt(raw.cosHide),
        cosRemove: toNonNegativeInt(raw.cosRemove),
        popPrevent: toNonNegativeInt(raw.popPrevent),
        overlayFix: toNonNegativeInt(raw.overlayFix),
        other: toNonNegativeInt(raw.other),
        weighted: 0,
    };
    refreshWeighted(counters);
    return counters;
}

function sanitizeNeutralizedStats(raw: unknown): NeutralizedStats {
    if (!isRecord(raw)) {
        return {
            sessionStartedAt: Date.now(),
            global: createEmptyCounters(),
            byDomain: {},
            netBlockMode: 'badge_estimate',
        };
    }

    return {
        sessionStartedAt: toNonNegativeInt(raw.sessionStartedAt, Date.now()),
        global: sanitizeNeutralizedCounters(raw.global),
        byDomain: isRecord(raw.byDomain)
            ? Object.fromEntries(
                  Object.entries(raw.byDomain)
                      .map(([domain, counters]) => [normalizeDomain(domain), sanitizeNeutralizedCounters(counters)] as const)
                      .filter((entry): entry is [string, NeutralizedCounters] => !!entry[0]),
              )
            : {},
        netBlockMode: raw.netBlockMode === 'debug_exact' ? 'debug_exact' : 'badge_estimate',
    };
}

function sanitizeSiteSettings(raw: unknown): SiteSettings {
    const site = { ...DEFAULT_SITE_SETTINGS };
    if (!isRecord(raw)) return site;

    if (typeof raw.mode === 'string' && VALID_MODES.has(raw.mode as FilteringMode)) {
        site.mode = raw.mode as FilteringMode;
    }

    site.hostPermissionGranted = isBoolean(raw.hostPermissionGranted) ? raw.hostPermissionGranted : false;
    site.cosmeticEnabled = isBoolean(raw.cosmeticEnabled) ? raw.cosmeticEnabled : site.mode !== 'lite';
    site.siteFixesEnabled = isBoolean(raw.siteFixesEnabled) ? raw.siteFixesEnabled : site.mode === 'advanced';
    site.disabled = isBoolean(raw.disabled) ? raw.disabled : false;

    site.mainWorldOff = isBoolean(raw.mainWorldOff) ? raw.mainWorldOff : false;
    site.cosmeticsOff = isBoolean(raw.cosmeticsOff) ? raw.cosmeticsOff : false;
    site.siteFixesOff = isBoolean(raw.siteFixesOff) ? raw.siteFixesOff : false;

    site.breakageCount = toNonNegativeInt(raw.breakageCount, 0);

    if (isFiniteNumber(raw.lastBreakageAt)) {
        site.lastBreakageAt = raw.lastBreakageAt;
    }
    if (isFiniteNumber(raw.relaxUntil)) {
        site.relaxUntil = raw.relaxUntil;
    }
    if (isFiniteNumber(raw.safeModeUntil)) {
        site.safeModeUntil = raw.safeModeUntil;
    }
    if (isFiniteNumber(raw.pauseCount)) {
        site.pauseCount = toNonNegativeInt(raw.pauseCount);
    }
    if (isFiniteNumber(raw.lastPauseAt)) {
        site.lastPauseAt = raw.lastPauseAt;
    }
    if (isFiniteNumber(raw.frictionScore)) {
        site.frictionScore = toNonNegativeInt(raw.frictionScore);
    }
    if (isFiniteNumber(raw.lastFrictionAt)) {
        site.lastFrictionAt = raw.lastFrictionAt;
    }

    return site;
}

function sanitizeStats(raw: unknown): StatsData {
    if (!isRecord(raw)) {
        return {
            ...DEFAULT_STATS,
            neutralized: sanitizeNeutralizedStats(DEFAULT_STATS.neutralized),
        };
    }
    return {
        totalBlocked: toNonNegativeInt(raw.totalBlocked),
        cosmeticHides: toNonNegativeInt(raw.cosmeticHides),
        heuristicRemovals: toNonNegativeInt(raw.heuristicRemovals),
        sessions: isRecord(raw.sessions)
            ? Object.fromEntries(
                  Object.entries(raw.sessions).map(([k, v]) => [k, toNonNegativeInt(v)]),
              )
            : {},
        neutralized: sanitizeNeutralizedStats(raw.neutralized),
    };
}

export class ExtensionServiceWorker {
    private settingsCache: StorageSchema['settings'] = { ...DEFAULT_SETTINGS.settings };
    private perSiteCache: Record<string, SiteSettings> = {};
    private statsBuffer: StatsData = sanitizeStats(DEFAULT_STATS);

    private tabStats: Record<number, number> = {};
    private tabBadgeState: Record<number, { domain: string; last: number }> = {};
    private debugNetBlockEnabled = false;
    private dnrDebugListener: ((info: any) => void) | null = null;

    private dirtySettings = false;
    private dirtyStats = false;

    private settingsTimer: ReturnType<typeof setTimeout> | null = null;
    private statsTimer: ReturnType<typeof setTimeout> | null = null;

    private cacheWarmed = false;
    private lastStatsFlushAt = 0;

    private metrics: RuntimeMetrics = {
        swWakeups: 0,
        storageWritesSettings: 0,
        storageWritesStats: 0,
        messageRejects: 0,
    };

    constructor() {
        this.init();
    }

    private init() {
        this.metrics.swWakeups += 1;

        chrome.runtime.onInstalled.addListener(() => this.onInstalled());
        chrome.runtime.onStartup.addListener(() => this.warmCache());
        chrome.runtime.onMessage.addListener((msg, sender, respond) => this.handleMessage(msg, sender, respond));
        chrome.alarms.onAlarm.addListener((alarm) => this.handleAlarm(alarm));
        chrome.permissions.onAdded?.addListener(() => {
            void this.verifyHostPermissions();
        });
        chrome.permissions.onRemoved?.addListener(() => {
            void this.verifyHostPermissions();
        });

        chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true });

        chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
            if (changeInfo.status === 'loading') {
                this.tabStats[tabId] = 0;
                delete this.tabBadgeState[tabId];
                return;
            }

            if (changeInfo.status === 'complete') {
                void this.sampleBadgeDeltaForTab(tabId);
            }
        });

        chrome.tabs.onActivated.addListener((activeInfo) => {
            void this.sampleBadgeDeltaForTab(activeInfo.tabId);
        });

        chrome.tabs.onRemoved.addListener((tabId) => {
            delete this.tabStats[tabId];
            delete this.tabBadgeState[tabId];
        });

        chrome.runtime.onSuspend?.addListener(() => this.flushAll());

        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;

            if (changes.settings?.newValue) {
                this.settingsCache = {
                    ...DEFAULT_SETTINGS.settings,
                    ...changes.settings.newValue,
                };
            }

            if (changes.perSite?.newValue && isRecord(changes.perSite.newValue)) {
                this.perSiteCache = Object.fromEntries(
                    Object.entries(changes.perSite.newValue).map(([domain, site]) => [domain, sanitizeSiteSettings(site)]),
                );
            }

            if (changes.stats?.newValue && !this.dirtyStats) {
                this.statsBuffer = sanitizeStats(changes.stats.newValue);
            }
        });

        void this.setupAlarms();
        void this.warmCache();
    }

    private async warmCache(): Promise<void> {
        const data = await chrome.storage.local.get(['settings', 'perSite', 'stats', 'schemaVersion']);

        this.settingsCache = {
            ...DEFAULT_SETTINGS.settings,
            ...(isRecord(data.settings) ? data.settings : {}),
        };

        if (isRecord(data.perSite)) {
            this.perSiteCache = Object.fromEntries(
                Object.entries(data.perSite).map(([domain, site]) => [domain, sanitizeSiteSettings(site)]),
            );
        }

        if (!this.cacheWarmed) {
            this.statsBuffer = sanitizeStats(data.stats);
            this.cacheWarmed = true;
        }

        if (!__MUGEN_DEBUG__) {
            this.statsBuffer.neutralized.netBlockMode = 'badge_estimate';
        }
        this.configureDebugRuleListener();

        const storedSchemaVersion = toNonNegativeInt(data.schemaVersion, 0);
        if (!storedSchemaVersion || storedSchemaVersion < SCHEMA_VERSION) {
            await this.migrateSchema(storedSchemaVersion || 1);
        }

        await this.verifyHostPermissions();
        await this.syncAllPerSiteRules();
    }

    private async verifyHostPermissions() {
        const permissions = await chrome.permissions.getAll();
        const origins = permissions.origins || [];

        let changed = false;

        for (const [domain, site] of Object.entries(this.perSiteCache)) {
            const hasPermission = origins.some((origin) => {
                return origin === `*://${domain}/*` || origin === `https://${domain}/*` || origin === `http://${domain}/*`;
            });

            if (site.hostPermissionGranted !== hasPermission) {
                site.hostPermissionGranted = hasPermission;
                changed = true;
            }
        }

        if (changed) {
            this.debouncePersistSettings();
        }
    }

    private debouncePersistSettings(): void {
        this.dirtySettings = true;
        if (this.settingsTimer) return;

        this.settingsTimer = setTimeout(async () => {
            this.settingsTimer = null;
            if (!this.dirtySettings) return;
            await this.persistSettingsNow();
        }, SETTINGS_DEBOUNCE_MS);
    }

    private scheduleStatsFlush(): void {
        if (!this.dirtyStats || this.statsTimer) return;

        const sinceLastFlush = Date.now() - this.lastStatsFlushAt;
        const minGap = Math.max(0, STATS_MIN_FLUSH_INTERVAL_MS - sinceLastFlush);
        const delay = Math.max(STATS_FLUSH_DEBOUNCE_MS, minGap);

        this.statsTimer = setTimeout(async () => {
            this.statsTimer = null;
            if (!this.dirtyStats) return;
            await this.flushStats();
        }, delay);
    }

    private maybeFlushStatsForUi(sender: chrome.runtime.MessageSender): void {
        if (!this.dirtyStats) return;
        if (!this.isPrivilegedSender(sender)) return;
        if (Date.now() - this.lastStatsFlushAt < UI_STATS_FLUSH_MIN_INTERVAL_MS) return;

        void this.flushStats();
    }

    private async flushStats(): Promise<void> {
        this.dirtyStats = false;
        this.lastStatsFlushAt = Date.now();
        await chrome.storage.local.set({ stats: { ...this.statsBuffer } });
        this.metrics.storageWritesStats += 1;
        this.persistMetricsIfEnabled();
    }

    private flushAll(): void {
        if (this.settingsTimer) {
            clearTimeout(this.settingsTimer);
            this.settingsTimer = null;
        }
        if (this.statsTimer) {
            clearTimeout(this.statsTimer);
            this.statsTimer = null;
        }

        if (this.dirtySettings) {
            this.dirtySettings = false;
            void chrome.storage.local.set({
                settings: this.settingsCache,
                perSite: this.perSiteCache,
            });
            this.metrics.storageWritesSettings += 1;
        }

        if (this.dirtyStats) {
            this.dirtyStats = false;
            this.lastStatsFlushAt = Date.now();
            void chrome.storage.local.set({ stats: { ...this.statsBuffer } });
            this.metrics.storageWritesStats += 1;
        }

        this.persistMetricsIfEnabled();
    }

    private async persistSettingsNow(): Promise<void> {
        this.dirtySettings = false;

        await chrome.storage.local.set({
            settings: this.settingsCache,
            perSite: this.perSiteCache,
        });

        this.metrics.storageWritesSettings += 1;
        this.persistMetricsIfEnabled();
    }

    private async forcePersistSettings(): Promise<void> {
        this.dirtySettings = false;

        if (this.settingsTimer) {
            clearTimeout(this.settingsTimer);
            this.settingsTimer = null;
        }

        await this.persistSettingsNow();
    }

    private persistMetricsIfEnabled(): void {
        if (!this.settingsCache.metricsEnabled) return;
        void chrome.storage.local.set({ [METRICS_KEY]: { ...this.metrics } });
    }

    private async onInstalled(): Promise<void> {
        const data = await chrome.storage.local.get('schemaVersion');
        if (!data.schemaVersion) {
            await chrome.storage.local.set(DEFAULT_SETTINGS);
        }

        await this.warmCache();
    }

    private async migrateSchema(from: number): Promise<void> {
        const backup = await chrome.storage.local.get(null);
        await chrome.storage.local.set({ _backup: backup });

        if (from < 3) {
            this.settingsCache = {
                ...DEFAULT_SETTINGS.settings,
                ...this.settingsCache,
            };

            for (const [domain, site] of Object.entries(this.perSiteCache)) {
                this.perSiteCache[domain] = sanitizeSiteSettings(site);
            }

            this.statsBuffer = sanitizeStats(this.statsBuffer);
        }

        if (from < 4) {
            const enabled = new Set(this.settingsCache.enabledRulesets || []);
            enabled.add('ruleset_easylist');
            enabled.add('ruleset_easyprivacy');
            this.settingsCache.enabledRulesets = Array.from(enabled).filter((id) => ALL_RULESETS.includes(id));
        }

        if (from < 5) {
            this.statsBuffer = sanitizeStats(this.statsBuffer);
            for (const [domain, site] of Object.entries(this.perSiteCache)) {
                this.perSiteCache[domain] = sanitizeSiteSettings(site);
            }
        }

        await chrome.storage.local.set({
            schemaVersion: SCHEMA_VERSION,
            settings: this.settingsCache,
            perSite: this.perSiteCache,
            stats: this.statsBuffer,
        });
    }

    private async setupAlarms(): Promise<void> {
        const existing = await chrome.alarms.get(UPDATE_ALARM_NAME);
        if (existing) return;

        const jitter = Math.round((Math.random() - 0.5) * 2 * JITTER_MINUTES);
        chrome.alarms.create(UPDATE_ALARM_NAME, {
            periodInMinutes: BASE_ALARM_MINUTES + jitter,
        });
    }

    private async handleAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
        if (alarm.name === UPDATE_ALARM_NAME) {
            await this.checkForUpdates();
            return;
        }

        if (!alarm.name.startsWith('relax-')) return;

        const domain = alarm.name.slice(6);
        const normalized = normalizeDomain(domain);
        if (!normalized) return;

        const site = this.perSiteCache[normalized];
        if (site?.relaxUntil && site.relaxUntil <= Date.now()) {
            delete site.relaxUntil;
            this.debouncePersistSettings();
        }

        await this.updateDnrForDomain(normalized);
    }

    private async checkForUpdates(): Promise<void> {
        // Remote update path intentionally disabled until signed data-only update pipeline is implemented.
    }

    private parseMessage(message: unknown): ParsedMessage {
        if (!isRecord(message) || typeof message.type !== 'string') {
            return { ok: false, error: 'INVALID_SCHEMA' };
        }

        const type = message.type;
        if (!Object.prototype.hasOwnProperty.call(MESSAGE_VALIDATORS, type)) {
            return { ok: false, error: 'UNKNOWN_TYPE' };
        }

        return MESSAGE_VALIDATORS[type](message);
    }

    private isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
        return !sender.id || sender.id === chrome.runtime.id;
    }

    private isPrivilegedSender(sender: chrome.runtime.MessageSender): boolean {
        if (!this.isTrustedSender(sender)) return false;
        if (!sender.url) return false;
        return sender.url.startsWith(chrome.runtime.getURL(''));
    }

    private handleMessage(
        message: unknown,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response?: any) => void,
    ): boolean | void {
        if (!this.isTrustedSender(sender)) {
            sendResponse({ ok: false, error: 'UNAUTHORIZED_SENDER' });
            return false;
        }

        const parsed = this.parseMessage(message);
        if (!parsed.ok) {
            this.metrics.messageRejects += 1;
            this.persistMetricsIfEnabled();
            sendResponse({ ok: false, error: parsed.error });
            return false;
        }

        const msg = parsed.message;

        switch (msg.type) {
            case 'GET_MODE':
                this.handleGetMode(msg.domain, sendResponse);
                return false;

            case 'SET_MODE':
                void this.handleSetMode(msg.domain, msg.mode, sendResponse);
                return true;

            case 'GET_STATS':
                this.maybeFlushStatsForUi(sender);
                sendResponse({
                    ok: true,
                    stats: { ...this.statsBuffer },
                    tabCount: sender.tab?.id ? this.tabStats[sender.tab.id] || 0 : 0,
                });
                return false;

            case 'GET_TAB_STATS': {
                const tabId = msg.tabId ?? sender.tab?.id;
                sendResponse({ ok: true, count: tabId ? this.tabStats[tabId] || 0 : 0 });
                return false;
            }

            case 'GET_DOMAIN_STATS':
                this.maybeFlushStatsForUi(sender);
                void this.handleGetDomainStats(msg.domain, msg.tabId ?? sender.tab?.id, sendResponse);
                return true;

            case 'GET_GLOBAL_STATS':
                this.maybeFlushStatsForUi(sender);
                sendResponse({
                    ok: true,
                    stats: cloneCounters(this.statsBuffer.neutralized.global),
                    netBlockMode: this.statsBuffer.neutralized.netBlockMode,
                });
                return false;

            case 'RESET_STATS':
                if (!this.isPrivilegedSender(sender)) {
                    sendResponse({ ok: false, error: 'UNAUTHORIZED' });
                    return false;
                }
                void this.handleResetStats(msg.scope, msg.domain, sendResponse);
                return true;

            case 'DEBUG_TOGGLE':
                if (!this.isPrivilegedSender(sender)) {
                    sendResponse({ ok: false, error: 'UNAUTHORIZED' });
                    return false;
                }
                this.handleDebugToggle(msg.enabled, sendResponse);
                return false;

            case 'GET_SITE_CONFIG':
                this.handleGetSiteConfig(msg.domain, sendResponse);
                return false;

            case 'SET_SITE_TOGGLE':
                void this.handleSetSiteToggle(msg.domain, msg.key, msg.value, sendResponse);
                return true;

            case 'SET_SITE_DISABLED':
                void this.handleSetSiteDisabled(msg.domain, msg.disabled, sendResponse);
                return true;

            case 'TEMPORARY_RELAX':
                void this.handleTemporaryRelax(msg.domain, msg.minutes, sendResponse);
                return true;

            case 'REQUEST_PERMISSIONS':
                if (!this.isPrivilegedSender(sender)) {
                    sendResponse({ ok: false, error: 'UNAUTHORIZED' });
                    return false;
                }
                void this.handleRequestPermissions(msg.domain, msg.granted, sendResponse);
                return true;

            case 'REPORT_ISSUE':
                void this.handleReportIssue(msg.domain, msg.details, sendResponse);
                return true;

            case 'EXPORT_SETTINGS':
                if (!this.isPrivilegedSender(sender)) {
                    sendResponse({ ok: false, error: 'UNAUTHORIZED' });
                    return false;
                }
                this.handleExportSettings(sendResponse);
                return false;

            case 'IMPORT_SETTINGS':
                if (!this.isPrivilegedSender(sender)) {
                    sendResponse({ ok: false, error: 'UNAUTHORIZED' });
                    return false;
                }
                void this.handleImportSettings(msg.data, sendResponse);
                return true;

            case 'RELOAD_RULES':
                if (!this.isPrivilegedSender(sender)) {
                    sendResponse({ ok: false, error: 'UNAUTHORIZED' });
                    return false;
                }
                void this.handleReloadRules(sendResponse);
                return true;

            case 'CLEAR_SITE_OVERRIDES':
                if (!this.isPrivilegedSender(sender)) {
                    sendResponse({ ok: false, error: 'UNAUTHORIZED' });
                    return false;
                }
                void this.handleClearSiteOverrides(sendResponse);
                return true;

            case 'INCREMENT_STATS':
                this.handleIncrementStats(msg.key, msg.count, sender.tab?.id, sender.tab?.url);
                sendResponse({ ok: true });
                return false;

            case 'RECORD_NEUTRALIZED':
                this.applyNeutralizedDelta(msg.domain, msg.deltas, msg.tabId ?? sender.tab?.id);
                sendResponse({ ok: true });
                return false;
        }
    }

    private handleIncrementStats(
        key: 'totalBlocked' | 'cosmeticHides' | 'heuristicRemovals',
        count: number,
        tabId?: number,
        tabUrl?: string,
    ): void {
        if (!VALID_STATS_KEYS.has(key)) return;
        const normalized = normalizeDomain(tabUrl);
        if (!normalized) {
            if (key === 'cosmeticHides') {
                this.statsBuffer.cosmeticHides += count;
            } else if (key === 'heuristicRemovals') {
                this.statsBuffer.heuristicRemovals += count;
            }
            this.statsBuffer.totalBlocked += count;
            if (tabId) {
                this.tabStats[tabId] = (this.tabStats[tabId] || 0) + count;
            }
            this.dirtyStats = true;
            this.scheduleStatsFlush();
            return;
        }

        if (key === 'cosmeticHides') {
            this.applyNeutralizedDelta(normalized, { COS_HIDE: count }, tabId);
            return;
        }

        if (key === 'heuristicRemovals') {
            this.applyNeutralizedDelta(normalized, { COS_REMOVE: count }, tabId);
            return;
        }

        this.applyNeutralizedDelta(normalized, { OTHER: count }, tabId);
    }

    private getOrCreateDomainCounters(domain: string): NeutralizedCounters {
        const existing = this.statsBuffer.neutralized.byDomain[domain];
        if (existing) return existing;

        const counters = createEmptyCounters();
        this.statsBuffer.neutralized.byDomain[domain] = counters;
        this.pruneNeutralizedDomains();
        return counters;
    }

    private pruneNeutralizedDomains(): void {
        const entries = Object.entries(this.statsBuffer.neutralized.byDomain);
        if (entries.length <= MAX_DOMAIN_STATS_ENTRIES) return;

        entries.sort((a, b) => b[1].weighted - a[1].weighted);
        this.statsBuffer.neutralized.byDomain = Object.fromEntries(entries.slice(0, MAX_DOMAIN_STATS_ENTRIES));
    }

    private incrementCounter(counters: NeutralizedCounters, category: NeutralizedCategory, count: number): void {
        if (category === 'NET_BLOCK') counters.netBlock += count;
        else if (category === 'COS_HIDE') counters.cosHide += count;
        else if (category === 'COS_REMOVE') counters.cosRemove += count;
        else if (category === 'POP_PREVENT') counters.popPrevent += count;
        else if (category === 'OVERLAY_FIX') counters.overlayFix += count;
        else counters.other += count;
    }

    private syncLegacyStatsFromNeutralized(): void {
        const global = this.statsBuffer.neutralized.global;
        this.statsBuffer.cosmeticHides = global.cosHide;
        this.statsBuffer.heuristicRemovals = global.cosRemove;
        this.statsBuffer.totalBlocked =
            global.netBlock + global.cosHide + global.cosRemove + global.popPrevent + global.overlayFix + global.other;
    }

    private applyNeutralizedDelta(
        domain: string,
        deltas: Partial<Record<NeutralizedCategory, number>>,
        tabId?: number,
    ): void {
        const normalized = normalizeDomain(domain);
        if (!normalized) return;

        const domainCounters = this.getOrCreateDomainCounters(normalized);
        const globalCounters = this.statsBuffer.neutralized.global;

        let totalForTab = 0;
        let changed = false;

        for (const [category, rawCount] of Object.entries(deltas)) {
            if (!VALID_NEUTRALIZED_CATEGORIES.has(category as NeutralizedCategory)) continue;
            const count = toNonNegativeInt(rawCount);
            if (count < 1) continue;

            const typedCategory = category as NeutralizedCategory;
            this.incrementCounter(domainCounters, typedCategory, count);
            this.incrementCounter(globalCounters, typedCategory, count);
            totalForTab += count;
            changed = true;
        }

        if (!changed) return;

        refreshWeighted(domainCounters);
        refreshWeighted(globalCounters);
        this.syncLegacyStatsFromNeutralized();

        if (tabId) {
            this.tabStats[tabId] = (this.tabStats[tabId] || 0) + totalForTab;
        }

        this.dirtyStats = true;
        this.scheduleStatsFlush();
    }

    private async sampleBadgeDelta(tabId: number, domain: string): Promise<void> {
        if (!tabId) return;
        const normalized = normalizeDomain(domain);
        if (!normalized) return;
        if (this.statsBuffer.neutralized.netBlockMode !== 'badge_estimate') return;

        const text = await new Promise<string>((resolve) => {
            chrome.action.getBadgeText({ tabId }, (badgeText) => resolve(badgeText || '0'));
        });

        const parsed = Number.parseInt(text, 10);
        const current = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
        const previous = this.tabBadgeState[tabId];

        if (!previous || previous.domain !== normalized) {
            this.tabBadgeState[tabId] = { domain: normalized, last: current };
            return;
        }

        const delta = current - previous.last;
        this.tabBadgeState[tabId] = { domain: normalized, last: current };

        if (delta > 0) {
            this.applyNeutralizedDelta(normalized, { NET_BLOCK: delta }, tabId);
        }
    }

    private async sampleBadgeDeltaForTab(tabId: number): Promise<void> {
        try {
            const tab = await chrome.tabs.get(tabId);
            const domain = normalizeDomain(tab.url);
            if (!domain) return;
            await this.sampleBadgeDelta(tabId, domain);
        } catch {
            // Ignore transient tab lookup failures.
        }
    }

    private async handleGetDomainStats(
        domain: string,
        tabId: number | undefined,
        respond: (response: any) => void,
    ): Promise<void> {
        const normalized = normalizeDomain(domain);
        if (!normalized) {
            respond({ ok: false, error: 'INVALID_DOMAIN' });
            return;
        }

        if (tabId) {
            try {
                await this.sampleBadgeDelta(tabId, normalized);
            } catch {
                // Ignore badge sampling errors and serve cached counters.
            }
        }

        const domainCounters = this.statsBuffer.neutralized.byDomain[normalized] || createEmptyCounters();
        respond({
            ok: true,
            domain: normalized,
            stats: cloneCounters(domainCounters),
            netBlockMode: this.statsBuffer.neutralized.netBlockMode,
        });
    }

    private async handleResetStats(
        scope: 'domain' | 'global' | 'all',
        domain: string | undefined,
        respond: (response: any) => void,
    ): Promise<void> {
        if (scope === 'domain') {
            const normalized = normalizeDomain(domain);
            if (!normalized) {
                respond({ ok: false, error: 'INVALID_DOMAIN' });
                return;
            }
            delete this.statsBuffer.neutralized.byDomain[normalized];
        } else if (scope === 'global' || scope === 'all') {
            this.statsBuffer.neutralized.global = createEmptyCounters();
            this.statsBuffer.neutralized.byDomain = {};
        }

        if (scope === 'domain') {
            const mergedGlobal = createEmptyCounters();
            for (const counters of Object.values(this.statsBuffer.neutralized.byDomain)) {
                mergedGlobal.netBlock += counters.netBlock;
                mergedGlobal.cosHide += counters.cosHide;
                mergedGlobal.cosRemove += counters.cosRemove;
                mergedGlobal.popPrevent += counters.popPrevent;
                mergedGlobal.overlayFix += counters.overlayFix;
                mergedGlobal.other += counters.other;
            }
            refreshWeighted(mergedGlobal);
            this.statsBuffer.neutralized.global = mergedGlobal;
        }

        this.syncLegacyStatsFromNeutralized();
        this.dirtyStats = true;
        await this.flushStats();
        respond({ ok: true });
    }

    private handleDebugToggle(enabled: boolean, respond: (response: any) => void): void {
        this.debugNetBlockEnabled = !!enabled;
        this.statsBuffer.neutralized.netBlockMode =
            __MUGEN_DEBUG__ && this.debugNetBlockEnabled ? 'debug_exact' : 'badge_estimate';

        this.configureDebugRuleListener();
        this.dirtyStats = true;
        this.scheduleStatsFlush();

        respond({
            ok: true,
            netBlockMode: this.statsBuffer.neutralized.netBlockMode,
            active: __MUGEN_DEBUG__ && this.debugNetBlockEnabled,
        });
    }

    private configureDebugRuleListener(): void {
        const dnr = chrome.declarativeNetRequest as typeof chrome.declarativeNetRequest & {
            onRuleMatchedDebug?: {
                addListener: (callback: (info: any) => void) => void;
                removeListener: (callback: (info: any) => void) => void;
            };
        };

        const shouldEnable = __MUGEN_DEBUG__ && this.debugNetBlockEnabled && !!dnr.onRuleMatchedDebug;

        if (!shouldEnable) {
            if (this.dnrDebugListener && dnr.onRuleMatchedDebug) {
                dnr.onRuleMatchedDebug.removeListener(this.dnrDebugListener);
                this.dnrDebugListener = null;
            }
            return;
        }

        if (this.dnrDebugListener) return;

        this.dnrDebugListener = (info: any) => {
            const requestUrl = typeof info?.request?.url === 'string' ? info.request.url : '';
            const initiator = typeof info?.request?.initiator === 'string' ? info.request.initiator : '';
            const domain = normalizeDomain(initiator) || normalizeDomain(requestUrl);
            if (!domain) return;
            this.applyNeutralizedDelta(domain, { NET_BLOCK: 1 });
        };

        try {
            dnr.onRuleMatchedDebug?.addListener(this.dnrDebugListener);
        } catch {
            this.dnrDebugListener = null;
            this.statsBuffer.neutralized.netBlockMode = 'badge_estimate';
        }
    }

    private handleGetMode(domain: string, respond: (response: FilteringMode) => void): void {
        const normalized = normalizeDomain(domain);
        if (!normalized) {
            respond('lite');
            return;
        }

        const site = this.perSiteCache[normalized];
        if (!site) {
            respond(this.settingsCache.mode || 'lite');
            return;
        }

        if (site.disabled) {
            respond('lite');
            return;
        }

        if (site.safeModeUntil && site.safeModeUntil > Date.now()) {
            respond('lite');
            return;
        }

        if (site.relaxUntil && site.relaxUntil > Date.now()) {
            respond('lite');
            return;
        }

        respond(site.mode || this.settingsCache.mode || 'lite');
    }

    private ensureSite(domain: string): SiteSettings {
        const site = this.perSiteCache[domain] || { ...DEFAULT_SITE_SETTINGS };
        this.perSiteCache[domain] = site;
        return site;
    }

    private isSiteInSafeMode(site: SiteSettings): boolean {
        return !!site.safeModeUntil && site.safeModeUntil > Date.now();
    }

    private isRelaxActive(site: SiteSettings): boolean {
        return !!site.relaxUntil && site.relaxUntil > Date.now();
    }

    private setSiteToSafeMode(site: SiteSettings, now: number): void {
        site.safeModeUntil = now + SAFE_MODE_MINUTES * 60_000;
        site.mode = 'lite';
        site.cosmeticEnabled = false;
        site.siteFixesEnabled = false;
        site.mainWorldOff = true;
        site.cosmeticsOff = true;
        site.siteFixesOff = true;
        delete site.relaxUntil;
    }

    private applyFriction(domain: string, source: 'pause' | 'report'): boolean {
        const site = this.ensureSite(domain);
        const now = Date.now();

        if (!site.lastFrictionAt || now - site.lastFrictionAt > BREAKAGE_WINDOW_MS) {
            site.frictionScore = 0;
        }

        site.lastFrictionAt = now;

        if (source === 'pause') {
            site.pauseCount = (site.pauseCount || 0) + 1;
            site.lastPauseAt = now;
            site.frictionScore = (site.frictionScore || 0) + 1;
        } else {
            site.frictionScore = (site.frictionScore || 0) + 2;
        }

        if ((site.frictionScore || 0) >= 3) {
            this.setSiteToSafeMode(site, now);
            return true;
        }

        return false;
    }

    private shouldApplyBypassRule(site: SiteSettings): boolean {
        return site.disabled || site.mode === 'lite' || this.isSiteInSafeMode(site);
    }

    private getDomainRuleIds(domain: string, base: number): [number, number] {
        const bucket = Math.abs(hashDomain(domain) % RULE_ID_SPAN);
        const first = base + bucket * 2;
        return [first, first + 1];
    }

    private buildAllowRulesForDomain(domain: string, ids: [number, number], priority: number) {
        return [
            {
                id: ids[0],
                priority,
                action: { type: 'allow' as chrome.declarativeNetRequest.RuleActionType },
                condition: {
                    initiatorDomains: [domain],
                    resourceTypes: NON_MAIN_FRAME_RESOURCE_TYPES,
                },
            },
            {
                id: ids[1],
                priority,
                action: { type: 'allow' as chrome.declarativeNetRequest.RuleActionType },
                condition: {
                    requestDomains: [domain],
                    resourceTypes: ['main_frame', 'sub_frame'] as chrome.declarativeNetRequest.ResourceType[],
                },
            },
        ];
    }

    private async updateDnrForDomain(domain: string): Promise<void> {
        const normalized = normalizeDomain(domain);
        if (!normalized) return;

        const site = this.perSiteCache[normalized];
        if (!site) return;

        if (site.relaxUntil && site.relaxUntil <= Date.now()) {
            delete site.relaxUntil;
            this.debouncePersistSettings();
        }

        if (site.safeModeUntil && site.safeModeUntil <= Date.now()) {
            delete site.safeModeUntil;
            this.debouncePersistSettings();
        }

        const bypassIds = this.getDomainRuleIds(normalized, SITE_BYPASS_RULE_ID_BASE);
        const relaxIds = this.getDomainRuleIds(normalized, RELAX_RULE_ID_BASE);

        const removeRuleIds = [bypassIds[0], bypassIds[1], relaxIds[0], relaxIds[1]];
        const addRules: chrome.declarativeNetRequest.Rule[] = [];

        if (this.shouldApplyBypassRule(site)) {
            addRules.push(...this.buildAllowRulesForDomain(normalized, bypassIds, 2_000));
        }

        if (this.isRelaxActive(site)) {
            addRules.push(...this.buildAllowRulesForDomain(normalized, relaxIds, 3_000));
        }

        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds,
            addRules,
        });
    }

    private async syncAllPerSiteRules(): Promise<void> {
        const pending = Object.keys(this.perSiteCache);
        for (const domain of pending) {
            try {
                await this.updateDnrForDomain(domain);
            } catch {
                // Ignore per-site DNR sync failure so one broken domain does not block startup.
            }
        }
    }

    private async clearManagedSessionRules(): Promise<void> {
        const rules = await chrome.declarativeNetRequest.getSessionRules();

        const managedIds = rules
            .map((rule) => rule.id)
            .filter((id) => {
                return (
                    (id >= RELAX_RULE_ID_BASE && id < RELAX_RULE_ID_BASE + RULE_ID_SPAN * 2) ||
                    (id >= SITE_BYPASS_RULE_ID_BASE && id < SITE_BYPASS_RULE_ID_BASE + RULE_ID_SPAN * 2)
                );
            });

        if (managedIds.length === 0) return;

        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: managedIds,
        });
    }

    private async handleSetMode(domain: string, mode: FilteringMode, respond: (response: any) => void): Promise<void> {
        const normalized = normalizeDomain(domain);
        if (!normalized) {
            respond({ ok: false, error: 'INVALID_DOMAIN' });
            return;
        }

        const site = this.ensureSite(normalized);
        site.mode = mode;
        site.disabled = false;
        site.cosmeticEnabled = mode !== 'lite';
        site.siteFixesEnabled = mode === 'advanced';

        if (mode !== 'advanced') {
            site.siteFixesOff = false;
        }

        if (mode !== 'lite') {
            delete site.safeModeUntil;
        }

        this.prunePerSiteCache();
        await this.forcePersistSettings();

        await this.updateDnrForDomain(normalized);
        respond({ ok: true, mode });
    }

    private handleGetSiteConfig(domain: string, respond: (response: any) => void): void {
        const normalized = normalizeDomain(domain);
        if (!normalized) {
            respond({ ok: false, error: 'INVALID_DOMAIN' });
            return;
        }

        const site = this.perSiteCache[normalized] || { ...DEFAULT_SITE_SETTINGS };
        respond({
            ok: true,
            config: site,
            globalMode: this.settingsCache.mode || 'lite',
            safeModeActive: this.isSiteInSafeMode(site),
            relaxActive: this.isRelaxActive(site),
        });
    }

    private async handleSetSiteToggle(
        domain: string,
        key: keyof Pick<SiteSettings, 'mainWorldOff' | 'cosmeticsOff' | 'siteFixesOff'>,
        value: boolean,
        respond: (response: any) => void,
    ): Promise<void> {
        const normalized = normalizeDomain(domain);
        if (!normalized) {
            respond({ ok: false, error: 'INVALID_DOMAIN' });
            return;
        }

        const site = this.ensureSite(normalized);
        site[key] = value;

        await this.forcePersistSettings();
        respond({ ok: true, config: site });
    }

    private async handleSetSiteDisabled(domain: string, disabled: boolean, respond: (response: any) => void): Promise<void> {
        const normalized = normalizeDomain(domain);
        if (!normalized) {
            respond({ ok: false, error: 'INVALID_DOMAIN' });
            return;
        }

        const site = this.ensureSite(normalized);
        site.disabled = disabled;

        if (disabled) {
            this.applyFriction(normalized, 'pause');
            site.mode = 'lite';
            site.cosmeticEnabled = false;
            site.siteFixesEnabled = false;
            site.mainWorldOff = true;
            site.cosmeticsOff = true;
            site.siteFixesOff = true;
            delete site.relaxUntil;
        } else {
            site.mainWorldOff = false;
            site.cosmeticsOff = false;
            site.siteFixesOff = false;
        }

        await this.forcePersistSettings();
        await this.updateDnrForDomain(normalized);

        respond({ ok: true, config: site });
    }

    private async handleTemporaryRelax(domain: string, minutes: number, respond: (response: any) => void): Promise<void> {
        const normalized = normalizeDomain(domain);
        if (!normalized || !isIntegerInRange(minutes, 1, 120)) {
            respond({ ok: false, error: 'INVALID_PARAMS' });
            return;
        }

        const until = Date.now() + minutes * 60_000;
        const site = this.ensureSite(normalized);
        site.relaxUntil = until;
        await this.forcePersistSettings();

        await this.updateDnrForDomain(normalized);
        chrome.alarms.create(`relax-${normalized}`, { delayInMinutes: minutes });

        respond({ ok: true, relaxUntil: until });
    }

    private async handleRequestPermissions(
        domain: string,
        granted: boolean | undefined,
        respond: (response: any) => void,
    ): Promise<void> {
        const normalized = normalizeDomain(domain);
        if (!normalized) {
            respond({ ok: false, error: 'INVALID_DOMAIN' });
            return;
        }

        if (typeof granted !== 'boolean') {
            respond({ ok: false, error: 'NEEDS_USER_GESTURE' });
            return;
        }

        const site = this.ensureSite(normalized);
        site.hostPermissionGranted = granted;
        await this.forcePersistSettings();

        respond({ ok: true, granted });
    }

    private async handleReportIssue(domain: string, details: string, respond: (response: any) => void): Promise<void> {
        const normalized = normalizeDomain(domain);
        if (!normalized) {
            respond({ ok: false, error: 'INVALID_DOMAIN' });
            return;
        }

        // Never store issue details (PII risk); keep bounded length for telemetry-free local validation only.
        const sanitizedDetails = details.slice(0, MAX_REPORT_DETAILS_LENGTH).trim();
        void sanitizedDetails;

        const site = this.ensureSite(normalized);
        const now = Date.now();

        if (!site.lastBreakageAt || now - site.lastBreakageAt > BREAKAGE_WINDOW_MS) {
            site.breakageCount = 1;
        } else {
            site.breakageCount += 1;
        }

        site.lastBreakageAt = now;

        const shouldEnterSafeMode = site.breakageCount >= 2 || this.applyFriction(normalized, 'report');
        if (shouldEnterSafeMode) {
            this.setSiteToSafeMode(site, now);
            await this.updateDnrForDomain(normalized);
        }

        await this.forcePersistSettings();
        respond({
            ok: true,
            autoSafeMode: shouldEnterSafeMode,
            safeModeUntil: site.safeModeUntil,
        });
    }

    private async handleReloadRules(respond: (response: any) => void): Promise<void> {
        const enabledIds = Array.from(
            new Set((this.settingsCache.enabledRulesets || []).filter((id) => ALL_RULESETS.includes(id))),
        );

        const disableIds = ALL_RULESETS.filter((id) => !enabledIds.includes(id));

        const dnrWithGet = chrome.declarativeNetRequest as typeof chrome.declarativeNetRequest & {
            getEnabledRulesets?: () => Promise<string[]>;
        };

        let previousEnabled: string[] = [];

        try {
            if (typeof dnrWithGet.getEnabledRulesets === 'function') {
                previousEnabled = await dnrWithGet.getEnabledRulesets();
            }

            await chrome.declarativeNetRequest.updateEnabledRulesets({
                enableRulesetIds: enabledIds,
                disableRulesetIds: disableIds,
            });

            respond({ ok: true, enabled: enabledIds });
        } catch (error) {
            if (previousEnabled.length > 0) {
                const rollbackDisable = ALL_RULESETS.filter((id) => !previousEnabled.includes(id));
                try {
                    await chrome.declarativeNetRequest.updateEnabledRulesets({
                        enableRulesetIds: previousEnabled,
                        disableRulesetIds: rollbackDisable,
                    });
                } catch {
                    // Best-effort rollback
                }
            }

            respond({ ok: false, error: String(error) });
        }
    }

    private handleExportSettings(respond: (response: any) => void): void {
        respond({
            ok: true,
            data: {
                settings: this.settingsCache,
                perSite: this.perSiteCache,
                stats: this.statsBuffer,
                schemaVersion: SCHEMA_VERSION,
            },
        });
    }

    private sanitizeImportData(raw: unknown): Partial<StorageSchema> | null {
        if (!isRecord(raw)) return null;

        const bytes = JSON.stringify(raw).length;
        if (bytes > MAX_IMPORT_BYTES) {
            return null;
        }

        const sanitized: Partial<StorageSchema> = {};

        if (isRecord(raw.settings)) {
            const inputSettings = raw.settings;
            const mode =
                typeof inputSettings.mode === 'string' && VALID_MODES.has(inputSettings.mode as FilteringMode)
                    ? (inputSettings.mode as FilteringMode)
                    : DEFAULT_SETTINGS.settings.mode;

            const enabledRulesets = Array.isArray(inputSettings.enabledRulesets)
                ? Array.from(
                      new Set(
                          inputSettings.enabledRulesets
                              .filter((id): id is string => typeof id === 'string')
                              .filter((id) => ALL_RULESETS.includes(id)),
                      ),
                  )
                : [...DEFAULT_SETTINGS.settings.enabledRulesets];

            sanitized.settings = {
                mode,
                enabledRulesets: enabledRulesets.length > 0 ? enabledRulesets : [...ALL_RULESETS],
                allowRemoteConfig: isBoolean(inputSettings.allowRemoteConfig)
                    ? inputSettings.allowRemoteConfig
                    : DEFAULT_SETTINGS.settings.allowRemoteConfig,
                metricsEnabled: isBoolean(inputSettings.metricsEnabled)
                    ? inputSettings.metricsEnabled
                    : DEFAULT_SETTINGS.settings.metricsEnabled,
            };
        }

        if (isRecord(raw.perSite)) {
            const entries = Object.entries(raw.perSite).slice(0, MAX_PER_SITE_ENTRIES);
            sanitized.perSite = Object.fromEntries(
                entries
                    .map(([domain, site]) => [normalizeDomain(domain), sanitizeSiteSettings(site)] as const)
                    .filter((entry): entry is [string, SiteSettings] => !!entry[0]),
            );
        }

        if (raw.stats !== undefined) {
            sanitized.stats = sanitizeStats(raw.stats);
        }

        sanitized.schemaVersion = SCHEMA_VERSION;
        return sanitized;
    }

    private async handleImportSettings(data: unknown, respond: (response: any) => void): Promise<void> {
        const sanitized = this.sanitizeImportData(data);
        if (!sanitized) {
            respond({ ok: false, error: 'INVALID_IMPORT' });
            return;
        }

        try {
            await chrome.storage.local.set({
                [LAST_KNOWN_GOOD_KEY]: {
                    settings: this.settingsCache,
                    perSite: this.perSiteCache,
                    stats: this.statsBuffer,
                    schemaVersion: SCHEMA_VERSION,
                    savedAt: Date.now(),
                },
            });

            if (sanitized.settings) {
                this.settingsCache = {
                    ...DEFAULT_SETTINGS.settings,
                    ...sanitized.settings,
                };
            }

            if (sanitized.perSite) {
                this.perSiteCache = sanitized.perSite;
            }

            if (sanitized.stats) {
                this.statsBuffer = sanitized.stats;
                this.dirtyStats = true;
                await this.flushStats();
            }

            await this.forcePersistSettings();
            await this.syncAllPerSiteRules();

            respond({ ok: true });
        } catch (error) {
            const lastGood = await chrome.storage.local.get(LAST_KNOWN_GOOD_KEY);
            const snapshot = lastGood[LAST_KNOWN_GOOD_KEY];

            if (isRecord(snapshot)) {
                this.settingsCache = {
                    ...DEFAULT_SETTINGS.settings,
                    ...(isRecord(snapshot.settings) ? snapshot.settings : {}),
                };
                this.perSiteCache = isRecord(snapshot.perSite)
                    ? Object.fromEntries(
                          Object.entries(snapshot.perSite).map(([domain, site]) => [domain, sanitizeSiteSettings(site)]),
                      )
                    : {};
                this.statsBuffer = sanitizeStats(snapshot.stats);

                await chrome.storage.local.set({
                    settings: this.settingsCache,
                    perSite: this.perSiteCache,
                    stats: this.statsBuffer,
                    schemaVersion: SCHEMA_VERSION,
                });
            }

            respond({ ok: false, error: String(error) });
        }
    }

    private async handleClearSiteOverrides(respond: (response: any) => void): Promise<void> {
        this.perSiteCache = {};
        await this.forcePersistSettings();
        await this.clearManagedSessionRules();
        respond({ ok: true });
    }

    public async getDnrRuleCount(): Promise<number> {
        try {
            const rules = await chrome.declarativeNetRequest.getSessionRules();
            return rules.length;
        } catch {
            return 0;
        }
    }

    private prunePerSiteCache(): void {
        const entries = Object.entries(this.perSiteCache);
        if (entries.length <= MAX_PER_SITE_ENTRIES) return;

        entries.sort((a, b) => (b[1].breakageCount || 0) - (a[1].breakageCount || 0));
        this.perSiteCache = Object.fromEntries(entries.slice(0, MAX_PER_SITE_ENTRIES));
    }

    public incrementStat(key: keyof Pick<StatsData, 'totalBlocked' | 'cosmeticHides' | 'heuristicRemovals'>, count = 1): void {
        this.handleIncrementStats(key, count);
    }
}

const MESSAGE_VALIDATORS: Record<string, (message: Record<string, unknown>) => ParsedMessage> = {
    GET_MODE: (message) => {
        return typeof message.domain === 'string'
            ? { ok: true, message: { type: 'GET_MODE', domain: message.domain } }
            : { ok: false, error: 'INVALID_DOMAIN' };
    },

    SET_MODE: (message) => {
        if (typeof message.domain !== 'string') return { ok: false, error: 'INVALID_DOMAIN' };
        if (typeof message.mode !== 'string' || !VALID_MODES.has(message.mode as FilteringMode)) {
            return { ok: false, error: 'INVALID_MODE' };
        }
        return {
            ok: true,
            message: {
                type: 'SET_MODE',
                domain: message.domain,
                mode: message.mode as FilteringMode,
            },
        };
    },

    GET_STATS: () => ({ ok: true, message: { type: 'GET_STATS' } }),

    GET_TAB_STATS: (message) => {
        if (message.tabId === undefined) {
            return { ok: true, message: { type: 'GET_TAB_STATS' } };
        }
        if (!isIntegerInRange(message.tabId, 0, Number.MAX_SAFE_INTEGER)) {
            return { ok: false, error: 'INVALID_PARAMS' };
        }
        return { ok: true, message: { type: 'GET_TAB_STATS', tabId: message.tabId } };
    },

    GET_DOMAIN_STATS: (message) => {
        if (typeof message.domain !== 'string') return { ok: false, error: 'INVALID_DOMAIN' };
        if (message.tabId !== undefined && !isIntegerInRange(message.tabId, 0, Number.MAX_SAFE_INTEGER)) {
            return { ok: false, error: 'INVALID_PARAMS' };
        }
        return {
            ok: true,
            message: {
                type: 'GET_DOMAIN_STATS',
                domain: message.domain,
                ...(message.tabId !== undefined ? { tabId: message.tabId } : {}),
            },
        };
    },

    GET_GLOBAL_STATS: () => ({ ok: true, message: { type: 'GET_GLOBAL_STATS' } }),

    GET_SITE_CONFIG: (message) => {
        return typeof message.domain === 'string'
            ? { ok: true, message: { type: 'GET_SITE_CONFIG', domain: message.domain } }
            : { ok: false, error: 'INVALID_DOMAIN' };
    },

    SET_SITE_TOGGLE: (message) => {
        if (typeof message.domain !== 'string') return { ok: false, error: 'INVALID_DOMAIN' };
        if (typeof message.key !== 'string' || !VALID_TOGGLES.has(message.key as any)) {
            return { ok: false, error: 'INVALID_TOGGLE' };
        }
        if (!isBoolean(message.value)) return { ok: false, error: 'INVALID_PARAMS' };

        return {
            ok: true,
            message: {
                type: 'SET_SITE_TOGGLE',
                domain: message.domain,
                key: message.key as keyof Pick<SiteSettings, 'mainWorldOff' | 'cosmeticsOff' | 'siteFixesOff'>,
                value: message.value,
            },
        };
    },

    SET_SITE_DISABLED: (message) => {
        if (typeof message.domain !== 'string') return { ok: false, error: 'INVALID_DOMAIN' };
        if (!isBoolean(message.disabled)) return { ok: false, error: 'INVALID_PARAMS' };

        return {
            ok: true,
            message: {
                type: 'SET_SITE_DISABLED',
                domain: message.domain,
                disabled: message.disabled,
            },
        };
    },

    TEMPORARY_RELAX: (message) => {
        if (typeof message.domain !== 'string') return { ok: false, error: 'INVALID_DOMAIN' };
        if (!isIntegerInRange(message.minutes, 1, 120)) return { ok: false, error: 'INVALID_PARAMS' };

        return {
            ok: true,
            message: {
                type: 'TEMPORARY_RELAX',
                domain: message.domain,
                minutes: message.minutes,
            },
        };
    },

    REQUEST_PERMISSIONS: (message) => {
        if (typeof message.domain !== 'string') return { ok: false, error: 'INVALID_DOMAIN' };
        if (message.granted !== undefined && !isBoolean(message.granted)) {
            return { ok: false, error: 'INVALID_PARAMS' };
        }
        return {
            ok: true,
            message: {
                type: 'REQUEST_PERMISSIONS',
                domain: message.domain,
                ...(message.granted !== undefined ? { granted: message.granted } : {}),
            },
        };
    },

    REPORT_ISSUE: (message) => {
        if (typeof message.domain !== 'string') return { ok: false, error: 'INVALID_DOMAIN' };
        if (typeof message.details !== 'string') return { ok: false, error: 'INVALID_SCHEMA' };

        return {
            ok: true,
            message: {
                type: 'REPORT_ISSUE',
                domain: message.domain,
                details: message.details,
            },
        };
    },

    RELOAD_RULES: () => ({ ok: true, message: { type: 'RELOAD_RULES' } }),
    EXPORT_SETTINGS: () => ({ ok: true, message: { type: 'EXPORT_SETTINGS' } }),

    IMPORT_SETTINGS: (message) => {
        if (message.data === undefined || !isRecord(message.data)) {
            return { ok: false, error: 'INVALID_SCHEMA' };
        }

        const bytes = JSON.stringify(message.data).length;
        if (bytes > MAX_IMPORT_BYTES) {
            return { ok: false, error: 'PAYLOAD_TOO_LARGE' };
        }

        return {
            ok: true,
            message: {
                type: 'IMPORT_SETTINGS',
                data: message.data,
            },
        };
    },

    CLEAR_SITE_OVERRIDES: () => ({ ok: true, message: { type: 'CLEAR_SITE_OVERRIDES' } }),

    INCREMENT_STATS: (message) => {
        if (typeof message.key !== 'string' || !VALID_STATS_KEYS.has(message.key as any)) {
            return { ok: false, error: 'INVALID_PARAMS' };
        }

        if (!isIntegerInRange(message.count, 1, MAX_STATS_INCREMENT)) {
            return { ok: false, error: 'INVALID_PARAMS' };
        }

        return {
            ok: true,
            message: {
                type: 'INCREMENT_STATS',
                key: message.key as 'totalBlocked' | 'cosmeticHides' | 'heuristicRemovals',
                count: message.count,
            },
        };
    },

    RECORD_NEUTRALIZED: (message) => {
        if (typeof message.domain !== 'string') return { ok: false, error: 'INVALID_DOMAIN' };
        if (!isRecord(message.deltas)) return { ok: false, error: 'INVALID_PARAMS' };
        if (message.tabId !== undefined && !isIntegerInRange(message.tabId, 0, Number.MAX_SAFE_INTEGER)) {
            return { ok: false, error: 'INVALID_PARAMS' };
        }

        const sanitizedDeltas = Object.fromEntries(
            Object.entries(message.deltas)
                .filter(([category]) => VALID_NEUTRALIZED_CATEGORIES.has(category as NeutralizedCategory))
                .map(([category, count]) => [category, toNonNegativeInt(count)]),
        ) as Partial<Record<NeutralizedCategory, number>>;

        return {
            ok: true,
            message: {
                type: 'RECORD_NEUTRALIZED',
                domain: message.domain,
                deltas: sanitizedDeltas,
                ...(message.tabId !== undefined ? { tabId: message.tabId } : {}),
            },
        };
    },

    RESET_STATS: (message) => {
        if (message.scope !== 'domain' && message.scope !== 'global' && message.scope !== 'all') {
            return { ok: false, error: 'INVALID_PARAMS' };
        }
        if (message.scope === 'domain' && typeof message.domain !== 'string') {
            return { ok: false, error: 'INVALID_DOMAIN' };
        }
        return {
            ok: true,
            message: {
                type: 'RESET_STATS',
                scope: message.scope,
                ...(typeof message.domain === 'string' ? { domain: message.domain } : {}),
            },
        };
    },

    DEBUG_TOGGLE: (message) => {
        if (!isBoolean(message.enabled)) return { ok: false, error: 'INVALID_PARAMS' };
        return {
            ok: true,
            message: {
                type: 'DEBUG_TOGGLE',
                enabled: message.enabled,
            },
        };
    },
};

new ExtensionServiceWorker();
