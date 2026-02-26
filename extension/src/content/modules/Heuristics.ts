import type { FilteringMode } from '@mugenblock/shared';

export interface HeuristicResult {
    isAd: boolean;
    confidence: number;
    reason?: string;
}

export class HeuristicsEngine {
    private visibilityObserver: IntersectionObserver;
    private visibilityMap: WeakMap<Element, boolean> = new WeakMap();

    constructor() {
        this.visibilityObserver = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    this.visibilityMap.set(entry.target, entry.isIntersecting);
                }
            },
            { threshold: [0, 0.1, 0.5, 0.9] },
        );
    }

    public observe(el: Element) {
        this.visibilityObserver.observe(el);
    }

    public analyzeNode(node: HTMLElement, mode: FilteringMode): HeuristicResult {
        if (this.isWhitelisted(node)) return { isAd: false, confidence: 0 };

        // 0. DNA Structural Fingerprinting (Highest Priority)
        // Targets: <div class="random"><iframe title="offer"></iframe></div>
        if (
            node.querySelector(
                'iframe[title="offer"], iframe[title="Advertisement"], iframe[scrolling="no"][src="about:blank"]',
            )
        ) {
            const rect = node.getBoundingClientRect();
            if (rect.width < 500 && rect.height < 400) {
                return { isAd: true, confidence: 1.0, reason: 'Ad Frame DNA Match' };
            }
        }

        // 1. Ghost Overlay Detection
        const ghostResult = this.checkGhostOverlays(node);
        if (ghostResult.isAd) return ghostResult;

        const tag = node.tagName.toLowerCase();
        const rect = node.getBoundingClientRect();
        const isAdSize =
            (rect.width === 300 && rect.height === 250) ||
            (rect.width === 728 && rect.height === 90) ||
            (rect.width === 160 && rect.height === 600) ||
            (rect.width === 300 && rect.height === 600) ||
            (rect.width === 320 && rect.height === 50);

        if (tag === 'iframe') {
            const iframe = node as HTMLIFrameElement;
            const src = iframe.src || '';
            const sandbox = iframe.getAttribute('sandbox') || '';

            if (
                isAdSize &&
                (sandbox.includes('allow-popups-to-escape-sandbox') ||
                    sandbox.includes('allow-top-navigation-by-user-activation'))
            ) {
                return { isAd: true, confidence: 1.0, reason: 'Malicious Ad Iframe Fingerprint' };
            }

            if (src && this.isSuspiciousDomain(src)) {
                return { isAd: true, confidence: 0.95, reason: 'DGA/Malicious Domain' };
            }

            const style = iframe.getAttribute('style') || '';
            if (
                style.includes('position: relative') &&
                (style.includes('height: 250px') || style.includes('width: 300px'))
            ) {
                if (sandbox && sandbox.includes('allow-scripts') && !src.includes(location.hostname)) {
                    return { isAd: true, confidence: 0.8, reason: 'Suspicious Iframe Styling' };
                }
            }
        }

        const classResult = this.checkClassEntropy(node);
        if (classResult.isAd) return classResult;

        if (node.hasAttribute('data-element') || node.hasAttribute('data-izone')) {
            return { isAd: true, confidence: 1.0, reason: 'Framework Marker' };
        }

        if (mode === 'advanced') {
            const structuralResult = this.checkStructuralAnomalies(node);
            if (structuralResult.isAd) return structuralResult;

            const behavioralResult = this.checkBehavioralFlags(node);
            if (behavioralResult.isAd) return behavioralResult;
        }

        return { isAd: false, confidence: 0 };
    }

    private checkGhostOverlays(node: HTMLElement): HeuristicResult {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return { isAd: false, confidence: 0 };

        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const area = rect.width * rect.height;
        const viewportArea = viewportWidth * viewportHeight;

        const isLarge = area > viewportArea * 0.5;
        const textContent = node.innerText.trim();
        const textLength = textContent.length;
        const hasNoContent = textLength === 0 && node.children.length === 0;

        // CRITICAL SAFETY: If the element has significant text or many children, it's likely legit site content.
        if (textLength > 50 || node.children.length > 8) return { isAd: false, confidence: 0 };
        if (!isLarge && !hasNoContent) return { isAd: false, confidence: 0 };

        const style = window.getComputedStyle(node);
        const zIndex = parseInt(style.zIndex, 10) || 0;
        const opacity = parseFloat(style.opacity);
        const pointerEvents = style.pointerEvents;
        const position = style.position;

        // Large transparent overlays with high z-index are almost always ads/hijackers
        if (isLarge && opacity < 0.1 && zIndex > 1000) {
            return { isAd: true, confidence: 0.9, reason: 'Ghost Overlay (Large/Transparent)' };
        }

        // Fixed/Absolute elements that are empty and transparent but catch all clicks
        if ((position === 'fixed' || position === 'absolute') && zIndex > 1000) {
            if (hasNoContent && pointerEvents === 'auto' && opacity < 0.1) {
                return { isAd: true, confidence: 0.95, reason: 'Ghost Overlay (Empty/Active)' };
            }
        }

        return { isAd: false, confidence: 0 };
    }

    private checkBehavioralFlags(node: HTMLElement): HeuristicResult {
        const id = node.id.toLowerCase();
        const cls = typeof node.className === 'string' ? node.className.toLowerCase() : '';

        const honeyPotPatterns = ['ad-test', 'ad-check', 'ad_unit', 'google_ads_iframe', 'adsense'];
        const isHoneyPot = honeyPotPatterns.some((p) => id.includes(p) || cls.includes(p));

        if (isHoneyPot) {
            const style = node.getAttribute('style') || '';
            if (style.includes('display: none') || style.includes('width: 1px') || style.includes('opacity: 0')) {
                return { isAd: true, confidence: 0.95, reason: 'Anti-Adblock Honey-pot' };
            }
        }

        return { isAd: false, confidence: 0 };
    }

    private checkClassEntropy(node: HTMLElement): HeuristicResult {
        const cls = node.className;
        if (typeof cls !== 'string' || cls.length < 20) return { isAd: false, confidence: 0 };

        // SAFETY: If the element has text, ARIA roles, or common UI attributes, it's NOT an ad
        if (node.innerText.trim().length > 10) return { isAd: false, confidence: 0 };
        if (node.hasAttribute('role') || node.hasAttribute('aria-label') || node.hasAttribute('data-testid'))
            return { isAd: false, confidence: 0 };

        // Framework detection (Vue/React/etc usually have these)
        const attrNames = node.getAttributeNames();
        if (attrNames.some((name) => name.startsWith('data-v-') || name.startsWith('_ngcontent')))
            return { isAd: false, confidence: 0 };

        const parts = cls.split(/\s+/).filter((p) => p.length > 15);

        const randomLike = parts.filter((c) => {
            const hasCaps = /[A-Z]/.test(c);
            const hasNums = /[0-9]/.test(c);
            const uniqueChars = new Set(c.toLowerCase()).size;
            // Extremely high entropy requirement: Long, mixed case, high character variety
            return c.length > 20 && hasCaps && hasNums && uniqueChars / c.length > 0.6;
        });

        // Only block if we see multiple EXTREMELY suspicious random strings
        // AND it's a hollow container (no text, few children)
        if (randomLike.length >= 2 && node.children.length < 3) {
            return { isAd: true, confidence: 0.9, reason: 'Obfuscated Hollow Container' };
        }

        return { isAd: false, confidence: 0 };
    }

    private checkStructuralAnomalies(node: HTMLElement): HeuristicResult {
        const style = node.getAttribute('style') || '';
        // Only block if transparent OR explicit ad context
        if (style.includes('z-index: 2147483647') && parseFloat(window.getComputedStyle(node).opacity) < 0.1) {
            return { isAd: true, confidence: 0.9, reason: 'Max Z-Index Overlay' };
        }

        const svg = node.tagName === 'svg' ? node : node.querySelector('svg');
        if (svg) {
            const viewBox = svg.getAttribute('viewBox');
            if (viewBox === '0 0 8 8' || viewBox === '0 0 87 16' || viewBox === '0 0 85 16') {
                return { isAd: true, confidence: 0.85, reason: 'Ad Close Fingerprint' };
            }
        }

        return { isAd: false, confidence: 0 };
    }

    public isVisible(el: Element): boolean {
        return this.visibilityMap.get(el) || false;
    }

    private isWhitelisted(node: HTMLElement): boolean {
        const cls = typeof node.className === 'string' ? node.className : '';
        const id = node.id || '';
        const tag = node.tagName.toLowerCase();

        // Global Whitelist for core UI elements
        if (tag === 'header' || tag === 'footer' || tag === 'nav' || tag === 'main' || tag === 'article') return true;

        if (location.hostname.includes('youtube.com')) {
            if (
                tag === 'img' ||
                tag === 'video' ||
                cls.includes('thumbnail') ||
                cls.includes('ytp-') ||
                cls.includes('ytd-') ||
                id.includes('thumbnail') ||
                node.closest('ytd-thumbnail, .ytd-thumbnail, ytd-rich-grid-media, ytd-video-renderer')
            ) {
                return true;
            }
        }

        if (location.hostname.includes('twitch.tv')) {
            if (tag === 'video' || cls.includes('tw-image') || cls.includes('preview-card')) {
                return true;
            }
        }

        return false;
    }

    public scanShadowRoots(root: Node): HTMLElement[] {
        const found: HTMLElement[] = [];
        const self = this;
        function walker(node: Node) {
            if (node instanceof HTMLElement) {
                const res = self.analyzeNode(node, 'advanced');
                if (res.isAd) found.push(node);
            }
            if (node instanceof Element && node.shadowRoot) {
                const shadowResults = self.scanShadowRoots(node.shadowRoot);
                shadowResults.forEach((n) => found.push(n));
            }
            if (node.childNodes) {
                for (let i = 0; i < node.childNodes.length; i++) {
                    walker(node.childNodes[i]);
                }
            }
        }
        if (root.childNodes) {
            for (let i = 0; i < root.childNodes.length; i++) {
                walker(root.childNodes[i]);
            }
        }
        return found;
    }

    private isSuspiciousDomain(url: string): boolean {
        try {
            const host = new URL(url).hostname;
            const majorCDNs = [
                'ytimg.com',
                'googleusercontent.com',
                'gstatic.com',
                'githubusercontent.com',
                'twimg.com',
                'fbcdn.net',
                'akamaihd.net',
                'cloudfront.net',
            ];
            if (majorCDNs.some((cdn) => host.endsWith(cdn))) return false;

            const name = host.split('.')[0];
            if (name.length > 12) {
                const consonants = (name.match(/[bcdfghjklmnpqrstvwxyz]/gi) || []).length;
                if (consonants / name.length > 0.8) return true;
                if (/[bcdfghjklmnpqrstvwxyz]{5,}/i.test(name)) return true;
            }

            const suspiciousTLDs = ['.in', '.pw', '.top', '.click', '.xyz', '.date', '.loan'];
            if (suspiciousTLDs.some((tld) => host.endsWith(tld))) {
                if (name.length > 10 && /^[a-z0-9]{10,}$/.test(name)) {
                    const uniqueChars = new Set(name).size;
                    if (uniqueChars / name.length < 0.4) return true;
                }
            }
        } catch {
            /* ... */
        }
        return false;
    }
}
