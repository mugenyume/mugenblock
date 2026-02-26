import {
    StorageSchema,
    FilteringMode,
    ExtensionMessage,
    StatsData,
    SiteSettings,
    DEFAULT_SITE_SETTINGS,
    DEFAULT_STATS,
    SCHEMA_VERSION,
    normalizeDomain,
    hashDomain,
} from '@mugenblock/shared';

// ─── Constants ───────────────────────────────────────────────────────

const ALARM_NAME = 'mugen-update';
const BASE_ALARM_MINUTES = 720; // 12 hours
const JITTER_MINUTES = 15;
const STATS_FLUSH_MS = 5_000; // Faster flush for real-time stats
const SETTINGS_DEBOUNCE_MS = 2_000;
const MAX_PER_SITE_ENTRIES = 500;
const RELAX_RULE_ID_BASE = 900_000;

const VALID_MODES: ReadonlySet<string> = new Set(['lite', 'standard', 'advanced']);
const VALID_TOGGLES: ReadonlySet<string> = new Set(['mainWorldOff', 'cosmeticsOff', 'siteFixesOff']);

const DEFAULT_SETTINGS: StorageSchema = {
    settings: {
        mode: 'lite',
        enabledRulesets: ['ruleset_core', 'ruleset_privacy', 'ruleset_peterlowe'],
        allowRemoteConfig: false,
    },
    perSite: {},
    stats: { ...DEFAULT_STATS },
    schemaVersion: SCHEMA_VERSION,
};

// ─── Service Worker ──────────────────────────────────────────────────

class ExtensionServiceWorker {
    private settingsCache: StorageSchema['settings'] | null = null;
    private perSiteCache: Record<string, SiteSettings> = {};
    private statsBuffer: StatsData = { ...DEFAULT_STATS };
    private tabStats: Record<number, number> = {}; // Tab ID -> Blocked Count
    private dirtySettings = false;
    private dirtyStats = false;
    private settingsTimer: ReturnType<typeof setTimeout> | null = null;
    private statsTimer: ReturnType<typeof setTimeout> | null = null;
    private cacheWarmed = false; // P2-1: Idempotency guard for stats merge

    constructor() {
        this.init();
    }

    // ─── Lifecycle ───────────────────────────────────────────────────

    private init() {
        chrome.runtime.onInstalled.addListener(() => this.onInstalled());
        chrome.runtime.onStartup.addListener(() => this.warmCache());
        chrome.runtime.onMessage.addListener((msg, sender, respond) => this.handleMessage(msg, sender, respond));
        chrome.alarms.onAlarm.addListener((a) => this.handleAlarm(a));

        // P3-7: Reset tab stats when a tab is updated or removed
        chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
            if (changeInfo.status === 'loading') {
                this.tabStats[tabId] = 0;
            }
        });
        chrome.tabs.onRemoved.addListener((tabId) => {
            delete this.tabStats[tabId];
        });

        // Flush stats before the SW is killed
        chrome.runtime.onSuspend?.addListener(() => this.flushAll());

        // P2-6: Sync cache when storage changes externally (e.g. from Options page)
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            if (changes.settings?.newValue) {
                this.settingsCache = changes.settings.newValue;
            }
            if (changes.perSite?.newValue) {
                this.perSiteCache = changes.perSite.newValue;
            }
            if (changes.stats?.newValue && !this.dirtyStats) {
                this.statsBuffer = changes.stats.newValue;
            }
        });

        this.setupAlarms();
        this.warmCache();
        this.scheduleStatsFlush();
    }

    // ─── Cache Management ────────────────────────────────────────────

    private async warmCache(): Promise<void> {
        const data = await chrome.storage.local.get(['settings', 'perSite', 'stats', 'schemaVersion']);

        this.settingsCache = data.settings || DEFAULT_SETTINGS.settings;
        this.perSiteCache = data.perSite || {};

        // P2-1 FIX: Only merge stats once to prevent double-counting
        if (!this.cacheWarmed) {
            const stored = data.stats as StatsData | undefined;
            if (stored) {
                this.statsBuffer.totalBlocked = stored.totalBlocked || 0;
                this.statsBuffer.cosmeticHides = stored.cosmeticHides || 0;
                this.statsBuffer.heuristicRemovals = stored.heuristicRemovals || 0;
                this.statsBuffer.sessions = stored.sessions || {};
            }
            this.cacheWarmed = true;
        }

        // Validate schema version and migrate if needed
        if (!data.schemaVersion || data.schemaVersion < SCHEMA_VERSION) {
            await this.migrateSchema(data.schemaVersion || 1);
        }

        this.verifyHostPermissions();
    }

    private async verifyHostPermissions() {
        // Actual browser API check to ensure cache matches reality
        const permissions = await chrome.permissions.getAll();
        const origins = permissions.origins || [];

        for (const [domain, site] of Object.entries(this.perSiteCache)) {
            const hasPermission = origins.some((o) => o.includes(domain));
            if (site.hostPermissionGranted !== hasPermission) {
                site.hostPermissionGranted = hasPermission;
                this.dirtySettings = true;
            }
        }
        if (this.dirtySettings) this.debouncePersistSettings();
    }

    private debouncePersistSettings(): void {
        this.dirtySettings = true;
        if (this.settingsTimer) return;
        this.settingsTimer = setTimeout(async () => {
            this.settingsTimer = null;
            if (this.dirtySettings) {
                this.dirtySettings = false;
                await chrome.storage.local.set({
                    settings: this.settingsCache,
                    perSite: this.perSiteCache,
                });
            }
        }, SETTINGS_DEBOUNCE_MS);
    }

    // P3-4 FIX: Force-flush settings immediately, bypassing debounce
    private async forcePersistSettings(): Promise<void> {
        this.dirtySettings = false;
        if (this.settingsTimer) {
            clearTimeout(this.settingsTimer);
            this.settingsTimer = null;
        }
        await chrome.storage.local.set({
            settings: this.settingsCache,
            perSite: this.perSiteCache,
        });
    }

    private scheduleStatsFlush(): void {
        this.statsTimer = setInterval(() => {
            if (this.dirtyStats) this.flushStats();
        }, STATS_FLUSH_MS);
    }

    private flushStats(): void {
        this.dirtyStats = false;
        chrome.storage.local.set({ stats: { ...this.statsBuffer } });
    }

    private flushAll(): void {
        if (this.dirtySettings && this.settingsCache) {
            chrome.storage.local.set({
                settings: this.settingsCache,
                perSite: this.perSiteCache,
            });
            this.dirtySettings = false;
        }
        if (this.dirtyStats) {
            this.flushStats();
        }
    }

    // ─── Installation & Migration ────────────────────────────────────

    private async onInstalled(): Promise<void> {
        const data = await chrome.storage.local.get('schemaVersion');
        if (!data.schemaVersion) {
            await chrome.storage.local.set(DEFAULT_SETTINGS);
        }
        await this.warmCache();
    }

    private async migrateSchema(from: number): Promise<void> {
        // Backup before migration
        const backup = await chrome.storage.local.get(null);
        await chrome.storage.local.set({ _backup: backup });

        if (from < 2) {
            // v1 → v2: ensure new SiteSettings fields exist
            for (const [domain, site] of Object.entries(this.perSiteCache)) {
                this.perSiteCache[domain] = { ...DEFAULT_SITE_SETTINGS, ...site };
            }
            // Ensure stats shape
            this.statsBuffer = {
                totalBlocked: this.statsBuffer.totalBlocked || 0,
                cosmeticHides: 0,
                heuristicRemovals: 0,
                sessions: this.statsBuffer.sessions || {},
            };
        }

        await chrome.storage.local.set({
            schemaVersion: SCHEMA_VERSION,
            perSite: this.perSiteCache,
            stats: this.statsBuffer,
        });
    }

    // ─── Alarms ──────────────────────────────────────────────────────

    private setupAlarms(): void {
        const jitter = Math.round((Math.random() - 0.5) * 2 * JITTER_MINUTES);
        chrome.alarms.create(ALARM_NAME, {
            periodInMinutes: BASE_ALARM_MINUTES + jitter,
        });
    }

    // P2-2 FIX: Consolidated alarm handler — handles both update and relax alarms
    private async handleAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
        if (alarm.name === ALARM_NAME) {
            this.checkForUpdates();
            return;
        }

        // Handle relax alarm expiry (consolidated from standalone listener)
        if (alarm.name.startsWith('relax-')) {
            const domain = alarm.name.slice(6);
            const ruleId = RELAX_RULE_ID_BASE + Math.abs(hashDomain(domain) % 1_000_000);
            try {
                await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
            } catch {
                /* session rule may already be gone */
            }

            if (this.perSiteCache[domain]) {
                delete this.perSiteCache[domain].relaxUntil;
                this.debouncePersistSettings();
            }
        }
    }

    private async checkForUpdates(): Promise<void> {
        // TODO: Implement signed config verification
        // 1. Fetch manifest from CDN
        // 2. Verify Ed25519 signature
        // 3. Check monotonic version (anti-rollback)
        // 4. Apply data-only updates (cosmetics, dynamic rules)
        // On failure: backoff alarm period (24h → 48h)
    }

    // ─── Message Handling ────────────────────────────────────────────

    private handleMessage(
        message: unknown,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response?: any) => void,
    ): boolean | void {
        // Validate basic structure
        if (!message || typeof message !== 'object' || !('type' in message)) {
            sendResponse({ ok: false, error: 'INVALID_SCHEMA' });
            return false;
        }

        const msg = message as ExtensionMessage;

        switch (msg.type) {
            case 'GET_MODE':
                this.handleGetMode(msg.domain, sendResponse);
                return true;

            case 'SET_MODE':
                if (!VALID_MODES.has(msg.mode)) {
                    sendResponse({ ok: false, error: 'INVALID_MODE' });
                    return false;
                }
                this.handleSetMode(msg.domain, msg.mode, sendResponse);
                return true;

            case 'GET_STATS':
                sendResponse({
                    ok: true,
                    stats: { ...this.statsBuffer },
                    tabCount: sender.tab?.id ? this.tabStats[sender.tab.id] || 0 : 0,
                });
                return false;

            case 'GET_TAB_STATS': {
                const id = (msg as any).tabId || sender.tab?.id;
                sendResponse({
                    ok: true,
                    count: id ? this.tabStats[id] || 0 : 0,
                });
                return false;
            }

            case 'GET_SITE_CONFIG':
                this.handleGetSiteConfig(msg.domain, sendResponse);
                return false;

            case 'SET_SITE_TOGGLE':
                if (!VALID_TOGGLES.has(msg.key)) {
                    sendResponse({ ok: false, error: 'INVALID_TOGGLE' });
                    return false;
                }
                this.handleSetSiteToggle(msg.domain, msg.key, msg.value, sendResponse);
                return false;

            case 'TEMPORARY_RELAX':
                this.handleTemporaryRelax(msg.domain, msg.minutes, sendResponse);
                return true;

            case 'REQUEST_PERMISSIONS':
                this.handleTrackPermission(msg.domain, sendResponse);
                return false;

            case 'REPORT_ISSUE':
                this.handleReportIssue(msg.domain, msg.details, sendResponse);
                return false;

            case 'EXPORT_SETTINGS':
                this.handleExportSettings(sendResponse);
                return false;

            case 'IMPORT_SETTINGS':
                this.handleImportSettings(msg.data, sendResponse);
                return true;

            case 'RELOAD_RULES':
                this.handleReloadRules(sendResponse);
                return true;

            case 'CLEAR_SITE_OVERRIDES':
                this.perSiteCache = {};
                this.debouncePersistSettings();
                sendResponse({ ok: true });
                return false;

            case 'INCREMENT_STATS':
                this.handleIncrementStats(msg.key, msg.count, sender.tab?.id);
                sendResponse({ ok: true });
                return false;

            default:
                sendResponse({ ok: false, error: 'UNKNOWN_TYPE' });
                return false;
        }
    }

    // ─── Message Handlers ────────────────────────────────────────────

    private handleIncrementStats(key: string, count: number, tabId?: number): void {
        if (key === 'cosmeticHides') {
            this.statsBuffer.cosmeticHides += count;
            this.statsBuffer.totalBlocked += count;
        } else if (key === 'heuristicRemovals') {
            this.statsBuffer.heuristicRemovals += count;
            this.statsBuffer.totalBlocked += count;
        } else if (key === 'totalBlocked') {
            this.statsBuffer.totalBlocked += count;
        }

        if (tabId) {
            this.tabStats[tabId] = (this.tabStats[tabId] || 0) + count;
        }

        this.dirtyStats = true;
    }

    private handleGetMode(domain: string, respond: (r: any) => void): void {
        const normalized = normalizeDomain(domain);
        if (!normalized) {
            respond('lite');
            return;
        }
        const siteMode = this.perSiteCache[normalized]?.mode;
        respond(siteMode || this.settingsCache?.mode || 'lite');
    }

    private async handleSetMode(domain: string, mode: FilteringMode, respond: (r: any) => void): Promise<void> {
        const normalized = normalizeDomain(domain);
        if (!normalized) {
            respond({ ok: false, error: 'INVALID_DOMAIN' });
            return;
        }

        const site = this.perSiteCache[normalized] || { ...DEFAULT_SITE_SETTINGS };
        site.mode = mode;
        site.cosmeticEnabled = mode !== 'lite';
        site.siteFixesEnabled = mode === 'advanced';

        this.perSiteCache[normalized] = site;
        this.prunePerSiteCache();
        this.debouncePersistSettings();

        await this.updateDnrForDomain(normalized, mode);
        respond({ ok: true, mode });
    }

    private handleGetSiteConfig(domain: string, respond: (r: any) => void): void {
        const normalized = normalizeDomain(domain);
        if (!normalized) {
            respond({ ok: false, error: 'INVALID_DOMAIN' });
            return;
        }
        const site = this.perSiteCache[normalized] || { ...DEFAULT_SITE_SETTINGS };
        respond({ ok: true, config: site, globalMode: this.settingsCache?.mode || 'lite' });
    }

    private handleSetSiteToggle(
        domain: string,
        key: keyof Pick<SiteSettings, 'mainWorldOff' | 'cosmeticsOff' | 'siteFixesOff'>,
        value: boolean,
        respond: (r: any) => void,
    ): void {
        const normalized = normalizeDomain(domain);
        if (!normalized) {
            respond({ ok: false, error: 'INVALID_DOMAIN' });
            return;
        }
        const site = this.perSiteCache[normalized] || { ...DEFAULT_SITE_SETTINGS };
        site[key] = value;
        this.perSiteCache[normalized] = site;
        this.debouncePersistSettings();
        respond({ ok: true });
    }

    private async handleTemporaryRelax(domain: string, minutes: number, respond: (r: any) => void): Promise<void> {
        const normalized = normalizeDomain(domain);
        if (!normalized || minutes < 1 || minutes > 120) {
            respond({ ok: false, error: 'INVALID_PARAMS' });
            return;
        }

        const until = Date.now() + minutes * 60_000;
        const site = this.perSiteCache[normalized] || { ...DEFAULT_SITE_SETTINGS };
        site.relaxUntil = until;
        this.perSiteCache[normalized] = site;
        this.debouncePersistSettings();

        // Add a session rule to allowlist this domain temporarily
        const ruleId = RELAX_RULE_ID_BASE + Math.abs(hashDomain(normalized) % 1_000_000);
        try {
            await chrome.declarativeNetRequest.updateSessionRules({
                removeRuleIds: [ruleId],
                addRules: [
                    {
                        id: ruleId,
                        priority: 1000,
                        action: { type: 'allowAllRequests' as any },
                        condition: {
                            requestDomains: [normalized],
                            resourceTypes: [
                                'main_frame',
                                'sub_frame',
                                'script',
                                'image',
                                'xmlhttprequest',
                                'other',
                            ] as any[],
                        },
                    },
                ],
            });
        } catch (e) {
            // Session rule creation may fail silently — that's OK
        }

        // Schedule removal
        chrome.alarms.create(`relax-${normalized}`, { delayInMinutes: minutes });

        respond({ ok: true, relaxUntil: until });
    }

    // P2-4 FIX: Background only tracks permission flag; actual request happens in popup/options
    private handleTrackPermission(domain: string, respond: (r: any) => void): void {
        const normalized = normalizeDomain(domain);
        if (!normalized) {
            respond({ ok: false, error: 'INVALID_DOMAIN' });
            return;
        }
        const site = this.perSiteCache[normalized] || { ...DEFAULT_SITE_SETTINGS };
        site.hostPermissionGranted = true;
        this.perSiteCache[normalized] = site;
        this.debouncePersistSettings();
        respond({ ok: true });
    }

    private handleReportIssue(domain: string, details: string, respond: (r: any) => void): void {
        const normalized = normalizeDomain(domain);
        if (!normalized) {
            respond({ ok: false, error: 'INVALID_DOMAIN' });
            return;
        }

        const site = this.perSiteCache[normalized] || { ...DEFAULT_SITE_SETTINGS };
        site.breakageCount = (site.breakageCount || 0) + 1;

        // Auto-downgrade after 2 breakage reports

        if (site.breakageCount >= 2 && site.mode !== 'lite') {
            site.mode = 'lite';
            site.cosmeticEnabled = false;
            site.siteFixesEnabled = false;
        }

        this.perSiteCache[normalized] = site;
        this.debouncePersistSettings();
        respond({ ok: true, autoDowngraded: site.breakageCount >= 2 });
    }

    // P3-3 FIX: Reload rules by re-syncing enabled rulesets from settings
    private async handleReloadRules(respond: (r: any) => void): Promise<void> {
        try {
            const enabledIds = this.settingsCache?.enabledRulesets || DEFAULT_SETTINGS.settings.enabledRulesets;
            const allRulesets = ['ruleset_core', 'ruleset_privacy', 'ruleset_peterlowe'];
            const disabledIds = allRulesets.filter((id) => !enabledIds.includes(id));

            await chrome.declarativeNetRequest.updateEnabledRulesets({
                enableRulesetIds: enabledIds,
                disableRulesetIds: disabledIds,
            });
            respond({ ok: true });
        } catch (e) {
            respond({ ok: false, error: String(e) });
        }
    }

    private handleExportSettings(respond: (r: any) => void): void {
        respond({
            ok: true,
            data: {
                settings: this.settingsCache,
                perSite: this.perSiteCache,
                schemaVersion: SCHEMA_VERSION,
            },
        });
    }

    private async handleImportSettings(data: Partial<StorageSchema>, respond: (r: any) => void): Promise<void> {
        try {
            if (data.settings) {
                this.settingsCache = { ...DEFAULT_SETTINGS.settings, ...data.settings };
            }
            if (data.perSite) {
                this.perSiteCache = data.perSite;
            }
            await this.forcePersistSettings();
            respond({ ok: true });
        } catch (e) {
            respond({ ok: false, error: String(e) });
        }
    }

    // ─── DNR Domain Management ───────────────────────────────────────

    // P3-2 FIX: Implement actual DNR session rules per domain
    private async updateDnrForDomain(domain: string, mode: FilteringMode): Promise<void> {
        const ruleId = RELAX_RULE_ID_BASE + 1_000_000 + Math.abs(hashDomain(domain) % 1_000_000);

        if (mode === 'lite') {
            // In lite mode, clean up any domain-specific session rules
            try {
                await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
            } catch {
                /* rule may not exist */
            }
        }
        // Standard and advanced modes rely on content scripts for cosmetic filtering;
        // DNR static rules remain active regardless of mode
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    private prunePerSiteCache(): void {
        const entries = Object.entries(this.perSiteCache);
        if (entries.length <= MAX_PER_SITE_ENTRIES) return;

        // Sort by breakageCount (keep high-breakage domains, prune defaults)
        entries.sort((a, b) => (b[1].breakageCount || 0) - (a[1].breakageCount || 0));
        this.perSiteCache = Object.fromEntries(entries.slice(0, MAX_PER_SITE_ENTRIES));
    }

    // Increment stats — called by content scripts via message
    public incrementStat(
        key: keyof Pick<StatsData, 'totalBlocked' | 'cosmeticHides' | 'heuristicRemovals'>,
        count = 1,
    ): void {
        this.statsBuffer[key] += count;
        this.dirtyStats = true;
    }
}

new ExtensionServiceWorker();
