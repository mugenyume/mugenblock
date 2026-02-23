import type { CosmeticConfig, SiteSettings } from '@mugenblock/shared';

const DEFAULT_SITE_SETTINGS: SiteSettings = {
    mode: 'lite',
    hostPermissionGranted: false,
    cosmeticEnabled: false,
    siteFixesEnabled: false,
    mainWorldOff: false,
    cosmeticsOff: false,
    siteFixesOff: false,
    breakageCount: 0,
};

// ─── Performance Budget Constants ────────────────────────────────────
const OBSERVER_BUDGET_MS = 8;
const IDLE_BATCH_SIZE = 50;
const QUIET_MODE_THRESHOLD_MS = 10_000;
const STYLE_ELEMENT_ID = 'mugen-shield-v2';
const HEAL_INTERVAL_MS = 8_000;

// ─── Cosmetic Engine ─────────────────────────────────────────────────

class CosmeticEngine {
    private config: CosmeticConfig | null = null;
    private observer: MutationObserver | null = null;
    private processedNodes: WeakSet<Node> = new WeakSet();
    private mode: string = 'lite';
    private siteConfig: SiteSettings = { ...DEFAULT_SITE_SETTINGS };
    private lastAdDetection = 0;
    private quietMode = false;
    private pendingIdleTask = false;
    private removalQueue: HTMLElement[] = [];
    private videoObserver: MutationObserver | null = null;
    private cssHash = '';

    // Local-only counters (never leave the device)
    private counters = {
        cosmeticHides: 0,
        heuristicRemovals: 0,
        mutationBatches: 0,
    };

    constructor() {
        this.init();
    }

    // ─── Initialization ──────────────────────────────────────────────

    private async init(): Promise<void> {
        const domain = location.hostname;
        if (!domain) return;

        let data: any;
        try {
            data = await chrome.storage.local.get(['perSite', 'settings']);
        } catch {
            return; // Extension context invalid (e.g., detached frame)
        }

        const siteOverride = data.perSite?.[domain];
        this.siteConfig = siteOverride ? { ...DEFAULT_SITE_SETTINGS, ...siteOverride } : { ...DEFAULT_SITE_SETTINGS };
        this.mode = this.siteConfig.mode || data.settings?.mode || 'lite';

        // Check temporary relax
        if (this.siteConfig.relaxUntil && Date.now() < this.siteConfig.relaxUntil) {
            return; // Site is relaxed — skip all content filtering
        }

        // Lite mode = DNR only, no content script work
        if (this.mode === 'lite') return;

        // Per-site kill switch: cosmetics disabled
        if (this.siteConfig.cosmeticsOff) return;

        this.config = this.buildConfig(domain);
        if (!this.config) return;

        // Phase 1: Immediate CSS shield (cheapest, most impactful)
        this.applyCss();

        // Phase 2: Fast cleanup when DOM is ready
        if (document.documentElement) {
            this.runFastCleanup();
        } else {
            document.addEventListener('DOMContentLoaded', () => this.runFastCleanup(), { once: true });
        }

        // Phase 3: Observer for dynamic content
        this.setupObserver();

        // Phase 4: CSS heal check (only if style gets removed by page scripts)
        this.setupCssHealCheck();

        // Phase 5: Video defense (advanced mode, event-driven)
        if (this.mode === 'advanced' && !this.siteConfig.siteFixesOff) {
            this.setupVideoObserver();
            this.setupClickProtection();
        }

        // Phase 6: Idle removal processor
        this.processRemovalQueue();
    }

    // ─── Config Builder ──────────────────────────────────────────────

    private buildConfig(domain: string): CosmeticConfig {
        // Fast selectors: ID/class/attribute — O(1) lookup by browser engine
        let fastSelectors = [
            '.ad-container', '#sidebar-ads', '.sponsored-post',
            '.ads-block', '.ad-box', '.ad-wrapper', '.ads-label',
            '[data-element]', '[data-izone]',
            'iframe[src*="exoclick"]', 'iframe[src*="adsterra"]',
            'iframe[src*="juicyads"]', 'iframe[src*="trafficjunky"]',
            'iframe[title="offer"]', 'iframe[title="Advertisement"]',
            'div[id^="__clb-spot_"]', 'iframe[id^="__clb-spot_"]',
            'div[class*="AdSlot"]', 'div[class*="AdsContainer"]',
            '.modal-backdrop',
        ];

        // Domain-specific safety: YouTube uses "ad-" in many legit player IDs/classes
        if (!domain.includes('youtube.com')) {
            fastSelectors.push('div[class*="ad-"]', 'div[id*="ad-"]');
        }

        // Slow selectors: require computed style checks, only in advanced mode
        const slowSelectors = this.mode === 'advanced' ? [
            'div[style*="z-index: 2147483647"]',
            'div[style*="bottom: 10px"] iframe',
            '.overlay-container',
        ] : [];

        return {
            fastSelectors,
            slowSelectors,
            hideRules: [],
            siteFixes: [],
        };
    }

    // ─── CSS Shield ──────────────────────────────────────────────────

    private applyCss(): void {
        if (!this.config) return;

        const allSelectors = [...this.config.fastSelectors, ...this.config.slowSelectors];
        if (!allSelectors.length) return;

        // Hash check: don't rewrite if selectors haven't changed
        const newHash = this.simpleHash(allSelectors.join(','));
        if (this.cssHash === newHash && document.getElementById(STYLE_ELEMENT_ID)) return;
        this.cssHash = newHash;

        let style = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement;
        if (!style) {
            style = document.createElement('style');
            style.id = STYLE_ELEMENT_ID;
            (document.head || document.documentElement).appendChild(style);
        }

        // Clean, minimal CSS — only display:none + visibility:hidden
        // No position:fixed, no z-index spam, no body/html overflow forcing
        const selectorBlock = allSelectors.join(',\n');
        style.textContent = `${selectorBlock} {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
}`;
    }

    private setupCssHealCheck(): void {
        // Only check periodically if the style element was removed by page scripts
        let healTimer: ReturnType<typeof setInterval> | null = null;
        healTimer = setInterval(() => {
            if (!document.getElementById(STYLE_ELEMENT_ID)) {
                this.cssHash = ''; // Force re-inject
                this.applyCss();
            }
        }, HEAL_INTERVAL_MS);
    }

    // ─── Fast Cleanup ────────────────────────────────────────────────

    private runFastCleanup(): void {
        if (!this.config) return;

        const selector = this.config.fastSelectors.join(', ');
        if (!selector) return;

        try {
            const elements = document.querySelectorAll(selector);
            for (let i = 0; i < elements.length; i++) {
                this.hideElement(elements[i] as HTMLElement);
            }
        } catch { /* malformed selector guard */ }
    }

    // ─── Element Handling ────────────────────────────────────────────

    private hideElement(el: HTMLElement): void {
        if (!el || this.processedNodes.has(el)) return;
        this.processedNodes.add(el);

        // Phase 1: Instant hide (CSS — no reflow)
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('visibility', 'hidden', 'important');
        this.counters.cosmeticHides++;

        // Phase 2: Queue for DOM removal in idle time
        this.removalQueue.push(el);
    }

    private processRemovalQueue(): void {
        const idle = (window as any).requestIdleCallback || ((cb: any) => setTimeout(cb, 100));

        const processChunk = () => {
            let processed = 0;
            while (this.removalQueue.length > 0 && processed < IDLE_BATCH_SIZE) {
                const el = this.removalQueue.shift()!;
                try {
                    el.remove();
                } catch { /* node may already be detached */ }
                processed++;
            }
            if (this.removalQueue.length > 0) {
                idle(processChunk, { timeout: 500 });
            } else {
                // Check again in 2s for new items
                setTimeout(() => {
                    if (this.removalQueue.length > 0) idle(processChunk, { timeout: 500 });
                    else this.processRemovalQueue();
                }, 2000);
            }
        };

        idle(processChunk, { timeout: 500 });
    }

    // ─── MutationObserver ────────────────────────────────────────────

    private setupObserver(): void {
        if (this.observer) return;

        this.observer = new MutationObserver((mutations) => {
            if (this.pendingIdleTask) return;

            const targets: HTMLElement[] = [];

            for (let i = 0; i < mutations.length; i++) {
                const mut = mutations[i];
                if (mut.type === 'childList') {
                    for (let j = 0; j < mut.addedNodes.length; j++) {
                        const node = mut.addedNodes[j];
                        if (node instanceof HTMLElement) targets.push(node);
                    }
                } else if (mut.type === 'attributes' && mut.target instanceof HTMLElement) {
                    targets.push(mut.target);
                }
            }

            if (targets.length === 0) return;

            // Instant: process ad-framework markers immediately (cheap check)
            for (let i = 0; i < targets.length; i++) {
                const t = targets[i];
                if (t.hasAttribute('data-element') || t.hasAttribute('data-izone')) {
                    this.nukeAdRoot(t);
                }
            }

            // Deferred: full analysis in idle time with budget
            this.pendingIdleTask = true;
            const idle = (window as any).requestIdleCallback || ((cb: any) => setTimeout(cb, 50));
            idle(() => {
                this.processNodesBudgeted(targets);
                this.pendingIdleTask = false;
                this.counters.mutationBatches++;
            }, { timeout: 200 });
        });

        this.observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-element', 'data-izone'],
        });
    }

    // ─── Budgeted Node Processing ────────────────────────────────────

    private processNodesBudgeted(nodes: HTMLElement[]): void {
        if (!this.config) return;

        const deadline = performance.now() + OBSERVER_BUDGET_MS;
        const fastSelector = this.config.fastSelectors.join(', ');

        for (let i = 0; i < nodes.length; i++) {
            if (performance.now() > deadline) break; // Budget exhausted

            const node = nodes[i];
            if (!node || !node.isConnected || this.processedNodes.has(node)) continue;

            this.analyzeNode(node, fastSelector);
        }

        // SPA quiet mode: if no ads found recently, reduce sensitivity
        if (this.counters.cosmeticHides === 0) {
            if (!this.quietMode && (performance.now() - this.lastAdDetection) > QUIET_MODE_THRESHOLD_MS) {
                this.quietMode = true;
            }
        } else {
            this.lastAdDetection = performance.now();
            this.quietMode = false;
        }
    }

    private analyzeNode(node: HTMLElement, fastSelector: string): void {
        if (!node.matches) return;

        // 1. Fast selector match
        try {
            if (fastSelector && node.matches(fastSelector)) {
                this.hideElement(node);
                return;
            }
        } catch { /* malformed selector */ }

        // 2. Ad framework attributes
        if (node.hasAttribute('data-element') || node.hasAttribute('data-izone')) {
            this.nukeAdRoot(node);
            return;
        }

        // 3. AdSlot class detection
        if (typeof node.className === 'string' && node.className.includes('AdSlot')) {
            this.nukeAdRoot(node);
            return;
        }

        // 4. Iframe with ad network src
        if (node.tagName === 'IFRAME') {
            const src = (node as HTMLIFrameElement).src || '';
            if (this.isAdNetworkUrl(src)) {
                this.hideElement(node);
                return;
            }
        }

        // 5. Advanced heuristics (only in advanced mode, not in quiet mode)
        if (this.mode === 'advanced' && !this.quietMode) {
            this.advancedHeuristics(node);
        }

        // 6. Check children (bounded, non-recursive via TreeWalker)
        if (node.children.length > 0 && node.children.length < 30) {
            for (let i = 0; i < node.children.length; i++) {
                const child = node.children[i] as HTMLElement;
                if (child && !this.processedNodes.has(child)) {
                    this.analyzeNode(child, fastSelector);
                }
            }
        }
    }

    // ─── Advanced Heuristics (Universal, Site-Agnostic) ──────────────

    private advancedHeuristics(node: HTMLElement): void {
        // A. High-entropy class cluster (obfuscated ad container)
        const cls = node.className;
        if (typeof cls === 'string' && cls.length > 0) {
            const parts = cls.split(/\s+/);
            if (parts.length >= 3) {
                const longObfuscated = parts.filter(c => c.length > 15 && /[A-Z]/.test(c) && /[0-9_]/.test(c));
                if (longObfuscated.length >= 3) {
                    const style = getComputedStyle(node);
                    if (style.position === 'fixed' || style.position === 'absolute') {
                        this.counters.heuristicRemovals++;
                        this.hideElement(node);
                        return;
                    }
                }
            }
        }

        // B. Fullscreen overlay with high z-index and empty/ad content
        try {
            const style = getComputedStyle(node);
            if (style.position === 'fixed' || style.position === 'absolute') {
                const z = parseInt(style.zIndex);
                if (z > 100) {
                    const rect = node.getBoundingClientRect();
                    const isFullscreen = rect.width > innerWidth * 0.7 && rect.height > innerHeight * 0.7;
                    if (isFullscreen) {
                        const textLen = (node.innerText || '').trim().length;
                        const hasAdAttr = node.hasAttribute('data-element') || node.hasAttribute('data-izone');
                        if (textLen === 0 || hasAdAttr) {
                            this.counters.heuristicRemovals++;
                            this.hideElement(node);
                            return;
                        }
                    }
                }
            }
        } catch { /* getComputedStyle can throw on detached nodes */ }

        // C. SVG fingerprinting for known ad close buttons
        if (node.tagName === 'svg' || node.querySelector?.('svg')) {
            const svg = node.tagName === 'svg' ? node : node.querySelector('svg');
            const viewBox = svg?.getAttribute('viewBox');
            if (viewBox === '0 0 8 8' || viewBox === '0 0 87 16' || viewBox === '0 0 85 16') {
                const parent = node.closest('div[style*="fixed"]');
                if (parent && parent instanceof HTMLElement) {
                    this.hideElement(parent);
                    return;
                }
            }
        }
    }

    private nukeAdRoot(node: HTMLElement): void {
        // Walk up to find the root container (fixed/absolute positioned ancestor)
        let root: HTMLElement = node;
        let current = node.parentElement;
        let depth = 0;
        while (current && current !== document.body && depth < 10) {
            try {
                const style = getComputedStyle(current);
                if (style.position === 'fixed' || style.position === 'absolute' || style.zIndex !== 'auto') {
                    root = current;
                }
            } catch { break; }
            current = current.parentElement;
            depth++;
        }
        this.hideElement(root);
    }

    // ─── Video Defense (Event-Driven) ────────────────────────────────

    private setupVideoObserver(): void {
        // Instead of polling every 2s, observe DOM for video element insertion
        this.videoObserver = new MutationObserver((mutations) => {
            for (const mut of mutations) {
                for (const node of mut.addedNodes) {
                    if (node instanceof HTMLVideoElement) {
                        this.guardVideo(node);
                    } else if (node instanceof HTMLElement) {
                        const videos = node.querySelectorAll('video');
                        for (let i = 0; i < videos.length; i++) {
                            this.guardVideo(videos[i] as HTMLVideoElement);
                        }
                    }
                }
            }
        });

        this.videoObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
        });

        // Also guard any videos already on the page
        document.querySelectorAll('video').forEach(v => this.guardVideo(v as HTMLVideoElement));
    }

    private guardVideo(video: HTMLVideoElement): void {
        if (video.hasAttribute('data-mugen-guarded')) return;
        video.setAttribute('data-mugen-guarded', 'true');

        const parent = video.parentElement;
        if (parent) {
            parent.style.setProperty('pointer-events', 'auto', 'important');
        }

        let highAlertActive = false;

        const triggerSweep = () => {
            if (highAlertActive) return;
            highAlertActive = true;

            // Quick 2-second high-alert: sweep every 150ms (reduced frequency for stability)
            let count = 0;
            const interval = setInterval(() => {
                this.runFastCleanup();
                this.nukeOverlaysNearVideo(video);
                count++;
                if (count >= 13) {
                    clearInterval(interval);
                    highAlertActive = false;
                }
            }, 150);

            // Immediate sweep
            this.runFastCleanup();
            this.nukeOverlaysNearVideo(video);
        };

        video.addEventListener('pause', triggerSweep);
        video.addEventListener('play', triggerSweep);
        video.addEventListener('fullscreenchange', triggerSweep);
        video.addEventListener('click', triggerSweep, { capture: true });
    }

    private nukeOverlaysNearVideo(video: HTMLVideoElement): void {
        const vRect = video.getBoundingClientRect();
        // Skip check if video is not visible or too small
        if (vRect.width < 50 || vRect.height < 50) return;

        const overlays = document.querySelectorAll('div[style*="fixed"], div[style*="absolute"]');

        for (let i = 0; i < overlays.length; i++) {
            const el = overlays[i] as HTMLElement;
            if (this.processedNodes.has(el)) continue;

            try {
                const style = getComputedStyle(el);
                const z = parseInt(style.zIndex);
                if (z <= 10) continue;

                const rect = el.getBoundingClientRect();
                const overlaps = !(rect.right < vRect.left || rect.left > vRect.right ||
                    rect.bottom < vRect.top || rect.top > vRect.bottom);

                if (overlaps && !el.contains(video)) {
                    // Critical: whitelist YouTube and generic player components
                    const isPlayerUI = el.matches('video, main, article, .content, .video-player, nav, header, footer, [class*="player"], [class*="controls"], .ytp-*, [id*="player"]');
                    if (!isPlayerUI) {
                        this.hideElement(el);
                    }
                }
            } catch { /* detached node */ }
        }
    }

    // ─── Click Protection ────────────────────────────────────────────

    private setupClickProtection(): void {
        document.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            if (!target?.matches) return;

            try {
                const style = getComputedStyle(target);
                if (style.position !== 'fixed' && style.position !== 'absolute') return;

                const z = parseInt(style.zIndex);
                if (z <= 10) return;

                const rect = target.getBoundingClientRect();
                if (rect.width > innerWidth * 0.4 && rect.height > innerHeight * 0.4) {
                    // Large overlay — check if it's safe content
                    if (!target.matches('video, main, article, .content, .video-player, nav, form, dialog')) {
                        e.preventDefault();
                        e.stopPropagation();
                        this.hideElement(target);
                    }
                }
            } catch { /* detached or restricted */ }
        }, true);
    }

    // ─── Utilities ───────────────────────────────────────────────────

    private isAdNetworkUrl(url: string): boolean {
        if (!url) return false;
        const lower = url.toLowerCase();
        const patterns = [
            'exoclick', 'adsterra', 'juicyads', 'trafficjunky', 'popunder',
            'clickunder', 'propellerads', 'hilltopads', 'adcash', 'clickadu',
            'popcash', 'popads', 'admaven', 'revcontent', 'mgid.com',
            'taboola', 'outbrain',
        ];
        return patterns.some(p => lower.includes(p));
    }

    private simpleHash(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
        }
        return hash.toString(36);
    }
}

new CosmeticEngine();
