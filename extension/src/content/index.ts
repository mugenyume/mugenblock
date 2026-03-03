import { DEFAULT_SITE_SETTINGS, FilteringMode } from './types';
import { CosmeticEngine } from './modules/CosmeticEngine';
import { MutationProcessor, type MutationProcessorOptions } from './modules/MutationProcessor';
import { HeuristicsEngine } from './modules/Heuristics';
import { InteractionGuard } from './modules/InteractionGuard';

const MAIN_WORLD_CONFIG_EVENT = '__MUGEN_MAIN_WORLD_CONFIG__';
const MAIN_WORLD_NEUTRALIZED_EVENT = '__MUGEN_NEUTRALIZED_EVENT__';
const ADVANCED_SWEEP_DELAYS_MS = [1_500, 4_500, 9_000];
const SHADOW_SCAN_LIMIT = 12;

const YOUTUBE_SWEEP_WINDOW_MS = 3_200;
const YOUTUBE_SWEEP_BACKOFF_MS = [250, 400, 650, 1_000];
const NEUTRALIZED_FLUSH_MS = 1_000;

type IdleCallback = (deadline: IdleDeadline) => void;
type NeutralizedDeltaKey = 'COS_HIDE' | 'COS_REMOVE' | 'POP_PREVENT' | 'OVERLAY_FIX';

function resolveEffectiveMode(
    globalMode: FilteringMode | undefined,
    siteOverride: any,
    now = Date.now(),
): FilteringMode {
    const fallbackMode: FilteringMode = globalMode || 'lite';
    if (!siteOverride) return fallbackMode;

    if (siteOverride.disabled) return 'lite';
    if (siteOverride.safeModeUntil && siteOverride.safeModeUntil > now) return 'lite';
    if (siteOverride.relaxUntil && siteOverride.relaxUntil > now) return 'lite';

    if (siteOverride.mode === 'lite' || siteOverride.mode === 'standard' || siteOverride.mode === 'advanced') {
        return siteOverride.mode;
    }

    return fallbackMode;
}

function resolveFeatureFlags(mode: FilteringMode, siteSettings: any): {
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

function scheduleIdle(callback: IdleCallback, timeout = 180): number {
    if (typeof requestIdleCallback === 'function') {
        return requestIdleCallback(callback, { timeout });
    }

    return window.setTimeout(() => {
        callback({
            didTimeout: true,
            timeRemaining: () => 0,
        } as IdleDeadline);
    }, 16);
}

function isYouTubeDomain(hostname: string): boolean {
    return (
        hostname === 'youtube.com' ||
        hostname.endsWith('.youtube.com') ||
        hostname === 'youtu.be' ||
        hostname.endsWith('.youtu.be')
    );
}

class MugenShield {
    private cosmetic = new CosmeticEngine();
    private heuristics = new HeuristicsEngine();
    private mutations = new MutationProcessor(this.heuristics);
    private interactions = new InteractionGuard();

    private domain = location.hostname;
    private isYouTube = isYouTubeDomain(this.domain);
    private mode: FilteringMode = 'lite';
    private siteConfig = { ...DEFAULT_SITE_SETTINGS };

    private latestFastSelector = '';

    private advancedSweepTimers = new Set<number>();
    private youtubeTriggerTeardowns: Array<() => void> = [];

    private lateSweepActive = false;
    private lateSweepDeadline = 0;
    private lateSweepNoChangePasses = 0;
    private lateSweepBackoffIndex = 0;
    private lateSweepTimer: number | null = null;

    private neutralizedBuffer: Partial<Record<NeutralizedDeltaKey, number>> = {};
    private neutralizedFlushTimer: number | null = null;

    private storageListener: ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void) | null = null;
    private mainWorldNeutralizedListener: ((event: Event) => void) | null = null;

    constructor() {
        if (location.protocol === 'about:' || location.protocol === 'chrome:' || window !== window.top) {
            return;
        }

        void this.bootstrap();
    }

    private async bootstrap() {
        if (!this.domain) return;

        try {
            const data = await chrome.storage.local.get(['perSite', 'settings']);
            this.applyConfig(data);
        } catch {
            this.teardownAggressiveFeatures();
        }

        this.storageListener = (changes, area) => {
            if (area !== 'local') return;
            if (!changes.perSite && !changes.settings) return;

            chrome.storage.local.get(['perSite', 'settings']).then((data) => {
                this.applyConfig(data);
            });
        };

        chrome.storage.onChanged.addListener(this.storageListener);

        this.mainWorldNeutralizedListener = (event: Event) => {
            const detail = (event as CustomEvent<{ category?: string }>).detail;
            if (!detail?.category) return;
            if (detail.category !== 'POP_PREVENT') return;
            this.reportNeutralized({ POP_PREVENT: 1 });
        };
        window.addEventListener(MAIN_WORLD_NEUTRALIZED_EVENT, this.mainWorldNeutralizedListener);

        this.installYouTubeTriggers();
        window.addEventListener('pagehide', () => this.destroy(), { once: true });
    }

    private applyConfig(data: any) {
        const siteOverride = data?.perSite?.[this.domain];
        const globalMode = data?.settings?.mode || 'lite';
        this.siteConfig = siteOverride
            ? { ...DEFAULT_SITE_SETTINGS, ...siteOverride }
            : { ...DEFAULT_SITE_SETTINGS, mode: globalMode };

        this.mode = resolveEffectiveMode(globalMode, siteOverride, Date.now());
        const featureFlags = resolveFeatureFlags(this.mode, this.siteConfig);

        const mainWorldEnabled = featureFlags.mainWorld && !this.isYouTube;
        this.sendMainWorldConfig(mainWorldEnabled);

        if (!featureFlags.cosmetics) {
            this.teardownAggressiveFeatures();
            return;
        }

        const config = this.buildConfig();
        const fastSelector = config.fastSelectors.join(', ');
        this.latestFastSelector = fastSelector;

        this.cosmetic.applyCss(config);

        const mutationOptions = this.buildMutationOptions();
        this.mutations.start(this.mode, fastSelector, mutationOptions, (delta) => {
            this.reportNeutralized({
                COS_HIDE: delta.cosHide,
                COS_REMOVE: delta.cosRemove,
            });
        });

        if (featureFlags.scriptGuard) {
            this.interactions.start(this.mode, (count) => this.reportNeutralized({ OVERLAY_FIX: count }));
        } else {
            this.interactions.stop();
        }

        this.scheduleInitialSweep(fastSelector);

        if (this.isYouTube) {
            this.clearAdvancedSweepTimers();
            this.triggerLateOverlaySweepWindow();
            return;
        }

        this.stopLateOverlaySweepWindow();
        this.scheduleAdvancedSweeps(fastSelector);
    }

    private buildMutationOptions(): MutationProcessorOptions {
        if (!this.isYouTube) {
            return { hideFastMatchesOnly: false, removalConfidenceThreshold: 0.9 };
        }

        return {
            hideFastMatchesOnly: true,
            removalConfidenceThreshold: 0.98,
        };
    }

    private installYouTubeTriggers(): void {
        if (!this.isYouTube || this.youtubeTriggerTeardowns.length > 0) return;

        const onNavigateFinish = () => this.triggerLateOverlaySweepWindow();
        const onPopState = () => this.triggerLateOverlaySweepWindow();
        const onVisibility = () => {
            if (document.visibilityState === 'visible') {
                this.triggerLateOverlaySweepWindow();
            } else if (document.visibilityState === 'hidden') {
                this.flushNeutralized();
            }
        };
        const onFullscreen = () => this.triggerLateOverlaySweepWindow();
        const onVideoPlay = (event: Event) => {
            if (event.target instanceof HTMLVideoElement) {
                this.triggerLateOverlaySweepWindow();
            }
        };

        window.addEventListener('yt-navigate-finish', onNavigateFinish);
        this.youtubeTriggerTeardowns.push(() => window.removeEventListener('yt-navigate-finish', onNavigateFinish));

        window.addEventListener('popstate', onPopState);
        this.youtubeTriggerTeardowns.push(() => window.removeEventListener('popstate', onPopState));

        document.addEventListener('visibilitychange', onVisibility, true);
        this.youtubeTriggerTeardowns.push(() => document.removeEventListener('visibilitychange', onVisibility, true));

        document.addEventListener('fullscreenchange', onFullscreen, true);
        this.youtubeTriggerTeardowns.push(() => document.removeEventListener('fullscreenchange', onFullscreen, true));

        document.addEventListener('play', onVideoPlay, true);
        this.youtubeTriggerTeardowns.push(() => document.removeEventListener('play', onVideoPlay, true));

        const historyApi = window.history;
        const originalPushState = historyApi.pushState;
        const originalReplaceState = historyApi.replaceState;

        historyApi.pushState = ((...args: Parameters<History['pushState']>) => {
            originalPushState.apply(historyApi, args);
            this.triggerLateOverlaySweepWindow();
        }) as History['pushState'];

        historyApi.replaceState = ((...args: Parameters<History['replaceState']>) => {
            originalReplaceState.apply(historyApi, args);
            this.triggerLateOverlaySweepWindow();
        }) as History['replaceState'];

        this.youtubeTriggerTeardowns.push(() => {
            historyApi.pushState = originalPushState;
            historyApi.replaceState = originalReplaceState;
        });
    }

    private triggerLateOverlaySweepWindow(): void {
        if (!this.isYouTube) return;
        if (!this.latestFastSelector) return;
        if (this.mode === 'lite' || this.siteConfig.disabled || this.siteConfig.cosmeticsOff) return;

        this.lateSweepDeadline = Date.now() + YOUTUBE_SWEEP_WINDOW_MS;
        if (this.lateSweepActive) return;

        this.lateSweepActive = true;
        this.lateSweepNoChangePasses = 0;
        this.lateSweepBackoffIndex = 0;
        this.runLateSweepPass();
    }

    private runLateSweepPass(): void {
        if (!this.lateSweepActive) return;
        if (Date.now() >= this.lateSweepDeadline) {
            this.stopLateOverlaySweepWindow();
            return;
        }

        const delta = this.runSweep(this.mode, this.latestFastSelector);

        if (delta.cosHide > 0 || delta.cosRemove > 0) {
            this.lateSweepNoChangePasses = 0;
            this.reportNeutralized({ COS_HIDE: delta.cosHide, COS_REMOVE: delta.cosRemove });
        } else {
            this.lateSweepNoChangePasses += 1;
        }

        if (this.lateSweepNoChangePasses >= 2) {
            this.stopLateOverlaySweepWindow();
            return;
        }

        const delay = YOUTUBE_SWEEP_BACKOFF_MS[Math.min(this.lateSweepBackoffIndex, YOUTUBE_SWEEP_BACKOFF_MS.length - 1)];
        this.lateSweepBackoffIndex += 1;

        this.lateSweepTimer = window.setTimeout(() => {
            this.lateSweepTimer = null;
            this.runLateSweepPass();
        }, delay);
    }

    private stopLateOverlaySweepWindow(): void {
        if (this.lateSweepTimer !== null) {
            clearTimeout(this.lateSweepTimer);
            this.lateSweepTimer = null;
        }
        this.lateSweepActive = false;
        this.lateSweepNoChangePasses = 0;
        this.lateSweepBackoffIndex = 0;
        this.lateSweepDeadline = 0;
    }

    private sendMainWorldConfig(enabled: boolean): void {
        window.dispatchEvent(
            new CustomEvent(MAIN_WORLD_CONFIG_EVENT, {
                detail: {
                    enabled,
                    mode: this.mode,
                    disabled: this.siteConfig.disabled,
                    mainWorldOff: this.siteConfig.mainWorldOff,
                },
            }),
        );
    }

    private scheduleInitialSweep(fastSelector: string): void {
        scheduleIdle(() => {
            let cosHide = 0;
            let cosRemove = 0;

            document.querySelectorAll(fastSelector).forEach((node) => {
                if (!(node instanceof HTMLElement)) return;
                const delta = this.mutations.analyzeAndHide(node, this.mode, fastSelector);
                cosHide += delta.cosHide;
                cosRemove += delta.cosRemove;
            });

            if (cosHide > 0 || cosRemove > 0) {
                this.reportNeutralized({ COS_HIDE: cosHide, COS_REMOVE: cosRemove });
            }
        });
    }

    private scheduleAdvancedSweeps(fastSelector: string): void {
        this.clearAdvancedSweepTimers();

        if (this.mode !== 'advanced') return;

        ADVANCED_SWEEP_DELAYS_MS.forEach((delay) => {
            const timerId = window.setTimeout(() => {
                this.advancedSweepTimers.delete(timerId);
                const delta = this.runSweep('advanced', fastSelector);
                if (delta.cosHide > 0 || delta.cosRemove > 0) {
                    this.reportNeutralized({ COS_HIDE: delta.cosHide, COS_REMOVE: delta.cosRemove });
                }
            }, delay);

            this.advancedSweepTimers.add(timerId);
        });
    }

    private runSweep(mode: FilteringMode, fastSelector: string): { cosHide: number; cosRemove: number } {
        let cosHide = 0;
        let cosRemove = 0;

        const sweepSelector = this.isYouTube
            ? [
                  'ytd-display-ad-renderer',
                  'ytd-promoted-sparkles-web-renderer',
                  'ytd-ad-slot-renderer',
                  'ytd-promoted-video-renderer',
                  'ytd-companion-slot-renderer',
                  'ytd-player-legacy-desktop-watch-ads-renderer',
                  '#player-ads',
                  '.video-ads',
                  'iframe[src*="doubleclick"]',
                  'iframe[src*="googlesyndication"]',
                  'div[style*="position: fixed"]',
                  'div[style*="position: absolute"]',
              ].join(', ')
            : 'iframe, div[style*="position: fixed"], div[style*="position: absolute"]';

        document.querySelectorAll(sweepSelector).forEach((el) => {
            if (!(el instanceof HTMLElement)) return;
            const delta = this.mutations.analyzeAndHide(el, mode, fastSelector);
            cosHide += delta.cosHide;
            cosRemove += delta.cosRemove;
        });

        if (mode === 'advanced') {
            const shadowAds = this.heuristics.scanShadowRoots(document.documentElement);
            shadowAds.slice(0, SHADOW_SCAN_LIMIT).forEach((el) => {
                const delta = this.mutations.analyzeAndHide(el, 'advanced', fastSelector);
                cosHide += delta.cosHide;
                cosRemove += delta.cosRemove;
            });
        }

        return { cosHide, cosRemove };
    }

    private clearAdvancedSweepTimers(): void {
        for (const timerId of this.advancedSweepTimers) {
            clearTimeout(timerId);
        }
        this.advancedSweepTimers.clear();
    }

    private teardownAggressiveFeatures(): void {
        this.clearAdvancedSweepTimers();
        this.stopLateOverlaySweepWindow();
        this.cosmetic.removeCss();
        this.mutations.stop();
        this.interactions.stop();
    }

    private destroy(): void {
        if (this.storageListener) {
            chrome.storage.onChanged.removeListener(this.storageListener);
            this.storageListener = null;
        }

        if (this.mainWorldNeutralizedListener) {
            window.removeEventListener(MAIN_WORLD_NEUTRALIZED_EVENT, this.mainWorldNeutralizedListener);
            this.mainWorldNeutralizedListener = null;
        }

        for (const teardown of this.youtubeTriggerTeardowns.splice(0)) {
            teardown();
        }

        if (this.neutralizedFlushTimer !== null) {
            clearTimeout(this.neutralizedFlushTimer);
            this.neutralizedFlushTimer = null;
        }

        this.flushNeutralized();
        this.teardownAggressiveFeatures();
        this.sendMainWorldConfig(false);
    }

    private reportNeutralized(deltas: Partial<Record<NeutralizedDeltaKey, number>>) {
        let changed = false;

        for (const [key, value] of Object.entries(deltas)) {
            const parsed = Math.max(0, Math.floor(Number(value) || 0));
            if (parsed < 1) continue;

            const typedKey = key as NeutralizedDeltaKey;
            this.neutralizedBuffer[typedKey] = (this.neutralizedBuffer[typedKey] || 0) + parsed;
            changed = true;
        }

        if (!changed) return;
        this.scheduleNeutralizedFlush();
    }

    private scheduleNeutralizedFlush(): void {
        if (this.neutralizedFlushTimer !== null) return;

        this.neutralizedFlushTimer = window.setTimeout(() => {
            this.neutralizedFlushTimer = null;
            this.flushNeutralized();
        }, NEUTRALIZED_FLUSH_MS);
    }

    private flushNeutralized(): void {
        const pending = this.neutralizedBuffer;
        if (Object.keys(pending).length === 0) return;

        this.neutralizedBuffer = {};

        try {
            chrome.runtime.sendMessage({
                type: 'RECORD_NEUTRALIZED',
                domain: this.domain,
                deltas: pending,
            });
        } catch {
            // Background may be suspended.
        }
    }

    private buildConfig() {
        const fastSelectors = [
            '.ad-container',
            '#sidebar-ads',
            '.sponsored-post',
            '.ads-block',
            '.ad-box',
            '.ad-wrapper',
            '.ads-label',
            '.ad-banner',
            '.ad-slot',
            '.ad-unit',
            '.advertisement',
            '[data-element]',
            '[data-izone]',
            '[data-ad]',
            'iframe[src*="doubleclick"]',
            'iframe[src*="googlesyndication"]',
            'iframe[src*="googleadservices"]',
            'iframe[src*="exoclick"]',
            'iframe[src*="adsterra"]',
            'iframe[src*="juicyads"]',
            'iframe[src*="trafficjunky"]',
            'iframe[src*="popads"]',
            'iframe[title="Advertisement"]',
            'iframe[title="Ad"]',
            'div[id*="google_ads"]',
            'div[id*="dfp-"]',
            'div[class*="AdSlot"]',
            'div[class*="AdsContainer"]',
            'div[class*="ad-container"]',
            'div[class*="ad-wrapper"]',
            'div[class*="sponsored"]',
            'div[data-google-query-id]',
            '.taboola',
            '#taboola',
            '.outbrain',
            '#outbrain',
            'div[class*="video-ads"]',
            'div[id*="player-ads"]',
            'ytd-display-ad-renderer',
            'ytd-promoted-sparkles-web-renderer',
            'ytd-ad-slot-renderer',
            'ytd-promoted-video-renderer',
            'ytd-companion-slot-renderer',
            'ytd-player-legacy-desktop-watch-ads-renderer',
        ];

        if (!this.isYouTube && !this.domain.includes('twitter.com')) {
            fastSelectors.push('div[class*="ad-"]', 'div[id*="ad-"]', 'a[class*="ad-"]', 'span[class*="ad-"]');
        }

        return {
            fastSelectors,
            slowSelectors:
                this.mode === 'advanced'
                    ? [
                          'div[style*="z-index: 2147483647"]',
                          'div[style*="position: fixed"][style*="opacity: 0"]',
                          '.overlay-ad',
                          '.interstitial-ad',
                          'div[aria-label*="Advertisement"]',
                      ]
                    : [],
            hideRules: [],
            siteFixes: [],
        };
    }
}

new MugenShield();
