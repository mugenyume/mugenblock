import { DEFAULT_SITE_SETTINGS, FilteringMode } from '@mugenblock/shared';
import { CosmeticEngine } from './modules/CosmeticEngine';
import { MutationProcessor } from './modules/MutationProcessor';
import { HeuristicsEngine } from './modules/Heuristics';
import { InteractionGuard } from './modules/InteractionGuard';

class MugenShield {
    private cosmetic = new CosmeticEngine();
    private heuristics = new HeuristicsEngine();
    private mutations!: MutationProcessor;
    private interactions!: InteractionGuard;

    private domain = location.hostname;
    private mode: FilteringMode = 'lite';
    private siteConfig = { ...DEFAULT_SITE_SETTINGS };
    private blockedCount = 0;
    private sweepTimer: ReturnType<typeof setInterval> | null = null;

    constructor() {
        if (location.protocol === 'about:' || location.protocol === 'chrome:' || window !== window.top) {
            return;
        }
        this.mutations = new MutationProcessor(this.heuristics);
        this.interactions = new InteractionGuard();
        this.bootstrap();
    }

    private async bootstrap() {
        if (!this.domain) return;

        try {
            const data = await chrome.storage.local.get(['perSite', 'settings']);
            this.applyConfig(data);
        } catch (e) {
            console.error('[Mugen] Init failed:', e);
        }

        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            chrome.storage.local.get(['perSite', 'settings']).then((data) => this.applyConfig(data));
        });
    }

    private applyConfig(data: any) {
        const siteOverride = data.perSite?.[this.domain];
        this.siteConfig = siteOverride ? { ...DEFAULT_SITE_SETTINGS, ...siteOverride } : { ...DEFAULT_SITE_SETTINGS };
        this.mode = (this.siteConfig.mode || data.settings?.mode || 'lite') as FilteringMode;

        if (this.siteConfig.relaxUntil && Date.now() < this.siteConfig.relaxUntil) {
            this.clearTimer();
            this.cosmetic.removeCss();
            this.mutations?.stop();
            return;
        }

        if (this.mode === 'lite') {
            this.clearTimer();
            this.cosmetic.removeCss();
            this.mutations?.stop();
            return;
        }

        if (this.siteConfig.cosmeticsOff) {
            this.clearTimer();
            this.cosmetic.removeCss();
            this.mutations?.stop();
            return;
        }

        const config = this.buildConfig();
        this.cosmetic.applyCss(config);

        const fastSelector = config.fastSelectors.join(', ');
        this.mutations.start(this.mode, fastSelector, (count: number) => {
            this.blockedCount += count;
            this.reportStats(count);
        });

        if (this.mode === 'advanced' && !this.siteConfig.siteFixesOff) {
            this.interactions.start(this.mode, (count) => {
                this.blockedCount += count;
                this.reportStats(count);
            });
        }

        // Periodic Sweep for persistent "ghost" ads (including Shadow DOM)
        this.clearTimer();
        this.sweepTimer = setInterval(() => {
            if (this.mode === 'lite') return;
            let sweepCount = 0;

            // 1. Standard DOM scan
            document
                .querySelectorAll('iframe, div[style*="position: fixed"], div[style*="position: absolute"]')
                .forEach((el) => {
                    if (el instanceof HTMLElement && this.mutations.analyzeAndHide(el, this.mode, '')) {
                        sweepCount++;
                    }
                });

            // 2. Deep Shadow DOM scan
            const shadowAds = this.heuristics.scanShadowRoots(document.documentElement);
            shadowAds.forEach((el) => {
                if (this.mutations.analyzeAndHide(el, this.mode, '')) {
                    sweepCount++;
                }
            });

            if (sweepCount > 0) {
                this.blockedCount += sweepCount;
                this.reportStats(sweepCount);
            }
        }, 3000);

        requestIdleCallback(() => {
            let idleScanCount = 0;
            document.querySelectorAll(fastSelector).forEach((el) => {
                if (el instanceof HTMLElement) {
                    if (this.mutations.analyzeAndHide(el, this.mode, fastSelector)) {
                        idleScanCount++;
                    }
                }
            });
            if (idleScanCount > 0) {
                this.blockedCount += idleScanCount;
                this.reportStats(idleScanCount);
            }
        });
    }

    private clearTimer() {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
    }

    private reportStats(count: number) {
        try {
            chrome.runtime.sendMessage({
                type: 'INCREMENT_STATS',
                key: 'cosmeticHides',
                count: count,
            });
        } catch {
            /* background may be unavailable */
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
        ];

        if (!this.domain.includes('youtube.com') && !this.domain.includes('twitter.com')) {
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
