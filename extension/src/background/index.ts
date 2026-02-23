
import {
    StorageSchema, FilteringMode, ExtensionMessage, StatsData,
    SiteSettings, DEFAULT_SITE_SETTINGS, DEFAULT_STATS, SCHEMA_VERSION
} from '@mugenblock/shared';

// ─── Constants ───────────────────────────────────────────────────────

const ALARM_NAME = 'mugen-update';
const BASE_ALARM_MINUTES = 720; // 12 hours
const JITTER_MINUTES = 15;
const STATS_FLUSH_MS = 60_000;
const SETTINGS_DEBOUNCE_MS = 2_000;
const MAX_PER_SITE_ENTRIES = 500;
const RELAX_RULE_ID_BASE = 900_000;

const VALID_MODES: ReadonlySet<string> = new Set(['lite', 'standard', 'advanced']);
const VALID_TOGGLES: ReadonlySet<string> = new Set(['mainWorldOff', 'cosmeticsOff', 'siteFixesOff']);

const DEFAULT_SETTINGS: StorageSchema = {
    settings: {
        mode: 'lite',
        enabledRulesets: ['ruleset_core', 'ruleset_privacy', 'ruleset_peterlowe'],
        allowRemoteConfig: true,
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
    private dirtySettings = false;
    private dirtyStats = false;
    private settingsTimer: ReturnType<typeof setTimeout> | null = null;
    private statsTimer: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        this.init();
    }

    // ─── Lifecycle ───────────────────────────────────────────────────

    private init() {
        chrome.runtime.onInstalled.addListener(() => this.onInstalled());
        chrome.runtime.onStartup.addListener(() => this.warmCache());
        chrome.runtime.onMessage.addListener((msg, sender, respond) =>
            this.handleMessage(msg, sender, respond));
        chrome.alarms.onAlarm.addListener((a) => this.handleAlarm(a));

        // Flush stats before the SW is killed
        chrome.runtime.onSuspend?.addListener(() => this.flushAll());

        this.setupAlarms();
        this.warmCache();
        this.scheduleStatsFlush();
    }

    // ─── Cache Management ────────────────────────────────────────────

    private async warmCache(): Promise<void> {
        const data = await chrome.storage.local.get(['settings', 'perSite', 'stats', 'schemaVersion']);

        this.settingsCache = data.settings || DEFAULT_SETTINGS.settings;
        this.perSiteCache = data.perSite || {};

        // Merge stored stats into buffer
        const stored = data.stats as StatsData | undefined;
        if (stored) {
            this.statsBuffer.totalBlocked += stored.totalBlocked;
            this.statsBuffer.cosmeticHides += stored.cosmeticHides;
            this.statsBuffer.heuristicRemovals += stored.heuristicRemovals;
        }

        // Schema migration
        if (!data.schemaVersion || data.schemaVersion < SCHEMA_VERSION) {
            await this.migrateSchema(data.schemaVersion || 1);
        }
    }

    private debouncePersistSettings(): void {
        this.dirtySettings = true;
        if (this.settingsTimer) return;
        this.settingsTimer = setTimeout(() => {
            this.settingsTimer = null;
            if (this.dirtySettings) {
                this.dirtySettings = false;
                chrome.storage.local.set({
                    settings: this.settingsCache,
                    perSite: this.perSiteCache,
                });
            }
        }, SETTINGS_DEBOUNCE_MS);
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
        await chrome.storage.local.set({ '_backup': backup });

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

    private handleAlarm(alarm: chrome.alarms.Alarm): void {
        if (alarm.name === ALARM_NAME) {
            this.checkForUpdates();
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
        sendResponse: (response?: any) => void
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
                sendResponse({ ok: true, stats: { ...this.statsBuffer } });
                return false;

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
                this.handleRequestPermissions(msg.domain, sendResponse);
                return true;

            case 'REPORT_ISSUE':
                this.handleReportIssue(msg.domain, sendResponse);
                return false;

            case 'EXPORT_SETTINGS':
                this.handleExportSettings(sendResponse);
                return false;

            case 'IMPORT_SETTINGS':
                this.handleImportSettings(msg.data, sendResponse);
                return true;

            case 'CLEAR_SITE_OVERRIDES':
                this.perSiteCache = {};
                this.debouncePersistSettings();
                sendResponse({ ok: true });
                return false;

            default:
                sendResponse({ ok: false, error: 'UNKNOWN_TYPE' });
                return false;
        }
    }

    // ─── Message Handlers ────────────────────────────────────────────

    private handleGetMode(domain: string, respond: (r: any) => void): void {
        const normalized = this.normalizeDomain(domain);
        if (!normalized) {
            respond('lite');
            return;
        }
        const siteMode = this.perSiteCache[normalized]?.mode;
        respond(siteMode || this.settingsCache?.mode || 'lite');
    }

    private async handleSetMode(domain: string, mode: FilteringMode, respond: (r: any) => void): Promise<void> {
        const normalized = this.normalizeDomain(domain);
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
        const normalized = this.normalizeDomain(domain);
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
        respond: (r: any) => void
    ): void {
        const normalized = this.normalizeDomain(domain);
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
        const normalized = this.normalizeDomain(domain);
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
        const ruleId = RELAX_RULE_ID_BASE + Math.abs(this.hashDomain(normalized) % 100_000);
        try {
            await chrome.declarativeNetRequest.updateSessionRules({
                removeRuleIds: [ruleId],
                addRules: [{
                    id: ruleId,
                    priority: 1000,
                    action: { type: 'allowAllRequests' as any },
                    condition: {
                        requestDomains: [normalized],
                        resourceTypes: ['main_frame', 'sub_frame', 'script', 'image', 'xmlhttprequest', 'other'] as any[],
                    },
                }],
            });
        } catch (e) {
            // Session rule creation may fail silently — that's OK
        }

        // Schedule removal
        chrome.alarms.create(`relax-${normalized}`, { delayInMinutes: minutes });

        respond({ ok: true, relaxUntil: until });
    }

    private async handleRequestPermissions(domain: string, respond: (r: any) => void): Promise<void> {
        const normalized = this.normalizeDomain(domain);
        if (!normalized) {
            respond({ ok: false, error: 'INVALID_DOMAIN' });
            return;
        }

        try {
            const granted = await chrome.permissions.request({ origins: [`*://${normalized}/*`] });
            if (granted) {
                const site = this.perSiteCache[normalized] || { ...DEFAULT_SITE_SETTINGS };
                site.hostPermissionGranted = true;
                this.perSiteCache[normalized] = site;
                this.debouncePersistSettings();
            }
            respond({ ok: granted });
        } catch (e) {
            respond({ ok: false, error: String(e) });
        }
    }

    private handleReportIssue(domain: string, respond: (r: any) => void): void {
        const normalized = this.normalizeDomain(domain);
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
            this.debouncePersistSettings();
            respond({ ok: true });
        } catch (e) {
            respond({ ok: false, error: String(e) });
        }
    }

    // ─── DNR Domain Management ───────────────────────────────────────

    private async updateDnrForDomain(domain: string, mode: FilteringMode): Promise<void> {
        // In "lite" mode on a specific domain, we could add an allowlist session rule
        // to reduce cosmetic processing; DNR rules themselves stay active
        // For now, mode changes are communicated to content scripts via storage
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    private normalizeDomain(input: string | undefined): string | null {
        if (!input || typeof input !== 'string') return null;
        try {
            const raw = input.includes('://') ? input : `https://${input}`;
            const u = new URL(raw);
            const h = u.hostname.toLowerCase();
            // Basic sanity
            if (!h || h.length > 253 || h.includes(' ')) return null;
            return h;
        } catch {
            return null;
        }
    }

    private hashDomain(domain: string): number {
        let hash = 0;
        for (let i = 0; i < domain.length; i++) {
            hash = ((hash << 5) - hash + domain.charCodeAt(i)) | 0;
        }
        return hash;
    }

    private prunePerSiteCache(): void {
        const entries = Object.entries(this.perSiteCache);
        if (entries.length <= MAX_PER_SITE_ENTRIES) return;

        // Sort by breakageCount (keep high-breakage domains, prune defaults)
        entries.sort((a, b) => (b[1].breakageCount || 0) - (a[1].breakageCount || 0));
        this.perSiteCache = Object.fromEntries(entries.slice(0, MAX_PER_SITE_ENTRIES));
    }

    // Increment stats — called by content scripts via message
    public incrementStat(key: keyof Pick<StatsData, 'totalBlocked' | 'cosmeticHides' | 'heuristicRemovals'>, count = 1): void {
        this.statsBuffer[key] += count;
        this.dirtyStats = true;
    }
}

// Handle relax alarm expiry
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name.startsWith('relax-')) {
        const domain = alarm.name.slice(6);
        // Remove session rule
        const ruleId = RELAX_RULE_ID_BASE + Math.abs(hashDomainStandalone(domain) % 100_000);
        try {
            await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
        } catch { }
        // Clear relaxUntil from storage
        const data = await chrome.storage.local.get('perSite');
        const perSite = data.perSite || {};
        if (perSite[domain]) {
            delete perSite[domain].relaxUntil;
            await chrome.storage.local.set({ perSite });
        }
    }
});

function hashDomainStandalone(domain: string): number {
    let hash = 0;
    for (let i = 0; i < domain.length; i++) {
        hash = ((hash << 5) - hash + domain.charCodeAt(i)) | 0;
    }
    return hash;
}

new ExtensionServiceWorker();
