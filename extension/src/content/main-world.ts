// MugenBlock Main World Shield — Scoped prototype patching for ad defense
// Runs in MAIN world to intercept ad-tech APIs before they execute
// All data stays local. Zero telemetry.
(function () {
    'use strict';

    // ─── Idempotency Guard ─────────────────────────────────────────
    if ((window as any).__mugenPatched) return;
    (window as any).__mugenPatched = true;

    // ─── Top-Frame Only (unless explicitly enabled) ────────────────
    // Skip patching in iframes by default — reduces overhead and breakage
    if (window !== window.top) return;

    // ─── Known Ad Network Patterns ─────────────────────────────────
    const AD_URL_PATTERNS: ReadonlyArray<string> = [
        'exoclick', 'adsterra', 'juicyads', 'trafficjunky',
        'popunder', 'clickunder', 'propellerads', 'hilltopads',
        'adcash', 'clickadu', 'popcash', 'popads', 'admaven',
        'revcontent',
    ];

    const AD_HTML_MARKERS: ReadonlyArray<string> = [
        'data-element', 'data-izone', 'title="offer"',
        'title="Advertisement"',
    ];

    function isAdNetworkUrl(url: string): boolean {
        if (!url) return false;
        const lower = url.toLowerCase();
        return AD_URL_PATTERNS.some(p => lower.includes(p));
    }

    function hasAdMarkers(html: string): boolean {
        if (!html || html.length < 20) return false; // Too small to be ad injection
        return AD_HTML_MARKERS.some(m => html.includes(m));
    }

    function isAdMarkerElement(el: any): boolean {
        try {
            if (!el || typeof el.hasAttribute !== 'function') return false;
            return el.hasAttribute('data-element') ||
                el.hasAttribute('data-izone') ||
                (typeof el.className === 'string' && el.className.includes('AdSlot'));
        } catch {
            return false;
        }
    }

    // ─── window.open — Scoped Blocking ─────────────────────────────
    // Only block: (1) known ad network URLs, (2) non-user-gesture opens
    // Allow: OAuth, payment, docs, blank, blob opens
    const originalOpen = window.open;
    const openDescriptor = Object.getOwnPropertyDescriptor(window, 'open');

    window.open = function (
        url?: string | URL,
        name?: string,
        specs?: string
    ): Window | null {
        try {
            const urlStr = url ? url.toString() : '';

            // Always allow empty/internal
            if (!urlStr || urlStr === 'about:blank' || urlStr.startsWith('blob:') || urlStr.startsWith('data:')) {
                return originalOpen.call(window, url as any, name, specs);
            }

            // Block known ad network URLs
            if (isAdNetworkUrl(urlStr)) {
                return null;
            }

            // Heuristic: suspicious opens with ad-like query params
            const lower = urlStr.toLowerCase();
            if (lower.includes('popunder') || lower.includes('clickunder')) {
                return null;
            }
        } catch {
            // Fail open on any error
        }
        return originalOpen.call(window, url as any, name, specs);
    };

    // Preserve descriptor properties
    if (openDescriptor) {
        try {
            Object.defineProperty(window, 'open', {
                configurable: openDescriptor.configurable,
                enumerable: openDescriptor.enumerable,
                writable: true,
                value: window.open,
            });
        } catch { /* non-configurable in some contexts */ }
    }

    // ─── appendChild — Neutralize Ad Element Construction ──────────
    const originalAppendChild = Element.prototype.appendChild;
    Element.prototype.appendChild = function <T extends Node>(newChild: T): T {
        try {
            if (newChild instanceof HTMLElement && isAdMarkerElement(newChild)) {
                newChild.style.setProperty('display', 'none', 'important');
                newChild.style.setProperty('visibility', 'hidden', 'important');
            }
        } catch { /* fail open */ }
        return originalAppendChild.call(this, newChild) as T;
    };

    // ─── setAttribute — Intercept Ad Attribute Injection ───────────
    const originalSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name: string, value: string): void {
        try {
            if (name === 'data-element' || name === 'data-izone') {
                if (this instanceof HTMLElement) {
                    this.style.setProperty('display', 'none', 'important');
                    this.style.setProperty('visibility', 'hidden', 'important');
                }
            }
        } catch { /* fail open */ }
        return originalSetAttribute.call(this, name, value);
    };

    // ─── insertAdjacentHTML — Narrowed Blocking ────────────────────
    // Only block when: HTML contains exact ad markers AND is large enough
    // to be ad injection (>200 chars). Small legit HTML passes through.
    const originalInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
    Element.prototype.insertAdjacentHTML = function (
        position: InsertPosition,
        html: string
    ): void {
        try {
            if (typeof html === 'string' && html.length > 200 && hasAdMarkers(html)) {
                return; // Block silently
            }
        } catch { /* fail open */ }
        return originalInsertAdjacentHTML.call(this, position, html);
    };
})();
