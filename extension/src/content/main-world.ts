// MugenBlock Sentinel — Universal Behavioral Shield
// Targets malicious intent patterns rather than specific site names
(function () {
    'use strict';

    if ((window as any).__mugenSentinel) return;
    (window as any).__mugenSentinel = true;

    if (location.protocol === 'about:' || location.protocol === 'chrome:' || window !== window.top) return;

    const AD_URL_PATTERNS = [
        'exoclick',
        'adsterra',
        'juicyads',
        'trafficjunky',
        'popunder',
        'clickunder',
        'propellerads',
        'hilltopads',
        'adcash',
        'clickadu',
        'popcash',
        'popads',
        'admaven',
        'revcontent',
    ];
    const CURRENT_ORIGIN = location.origin;
    const originalToString = Function.prototype.toString;
    const patchedRegistry = new Map<Function, string>();

    // ─── Interaction State ─────────────────────────────────────────
    let lastValidInteractionTime = 0;
    let lastInteractionTarget: HTMLElement | null = null;

    function isSafeElement(el: HTMLElement | null): boolean {
        if (!el) return false;
        const tag = el.tagName.toLowerCase();
        const hasText = el.innerText.trim().length > 0;
        const isInteractive =
            ['a', 'button', 'input', 'select', 'textarea'].includes(tag) || el.closest('a, button, [role="button"]');

        // A "Safe" element must be interactive AND have visible content OR be a clear UI icon
        return !!(isInteractive && (hasText || el.querySelector('svg, img') || el.clientWidth < 100));
    }

    // ─── Stealth & Masking ─────────────────────────────────────────
    Function.prototype.toString = function () {
        if (patchedRegistry.has(this)) return patchedRegistry.get(this)!;
        return originalToString.call(this);
    };
    function mask(patched: Function, original: Function) {
        patchedRegistry.set(patched, originalToString.call(original));
    }

    // ─── Universal Domain Scoring ──────────────────────────────────
    function getDomainScore(url: string): number {
        try {
            const host = new URL(url, location.href).hostname;
            if (host.includes(location.hostname)) return 0; // Safe: Same site

            let score = 0;
            const suspiciousTLDs = ['.in', '.pw', '.top', '.xyz', '.date', '.loan', '.click', '.info'];
            if (suspiciousTLDs.some((tld) => host.endsWith(tld))) score += 50;

            const name = host.split('.')[0];
            if (name.length > 12) score += 30;
            if (/[0-9]{3,}/.test(name)) score += 20; // Multiple numbers in domain
            if (!/[aeiouy]/.test(name.slice(0, 6))) score += 40; // No vowels in start (Gibberish)

            return score;
        } catch {
            return 100;
        }
    }

    function isMaliciousIntent(url: string): boolean {
        const score = getDomainScore(url);
        const timeSinceInteraction = Date.now() - lastValidInteractionTime;

        // Malicious if: (1) High domain score OR (2) No recent valid user interaction
        if (score > 60) return true;
        if (timeSinceInteraction > 1000 && !isSafeElement(lastInteractionTarget)) return true;

        return AD_URL_PATTERNS.some((p) => url.toLowerCase().includes(p));
    }

    // ─── window.open — Hardened ───────────────────────────────────
    const originalOpen = window.open;
    window.open = function (url?: string | URL, name?: string, specs?: string): any {
        const urlStr = url ? url.toString() : '';
        if (isMaliciousIntent(urlStr)) {
            return new Proxy({}, { get: (_, p) => (p === 'closed' ? true : () => {}) });
        }
        return originalOpen.call(window, url as any, name, specs);
    };
    mask(window.open, originalOpen);

    // ─── Tracker ───────────────────────────────────────────────────
    window.addEventListener(
        'mousedown',
        (e) => {
            lastInteractionTarget = e.target as HTMLElement;
            if (isSafeElement(lastInteractionTarget)) {
                lastValidInteractionTime = Date.now();
            }
        },
        { capture: true },
    );

    // ─── Universal Ghost Link Trap ─────────────────────────────────
    document.addEventListener(
        'click',
        (e) => {
            const target = e.target as HTMLElement;
            const link = target.closest('a');

            if (link) {
                const url = link.href;
                if (isMaliciousIntent(url) || (!isSafeElement(target) && link.target === '_blank')) {
                    e.stopImmediatePropagation();
                    e.preventDefault();
                    link.remove();
                }
            }
        },
        { capture: true },
    );

    // ─── Network Mirroring ─────────────────────────────────────────
    const originalFetch = window.fetch;
    window.fetch = async function (input: any, init?: any) {
        const url = input instanceof Request ? input.url : input.toString();
        if (isMaliciousIntent(url)) {
            return new Response(JSON.stringify({ status: 'ok', data: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        return originalFetch.call(this, input, init);
    };
    mask(window.fetch, originalFetch);

    // ─── Global Styling ────────────────────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
        /* Universal "Ghost" Neutralization */
        [style*="z-index: 2147483647"], [style*="z-index: 999999"] {
            pointer-events: none !important;
            opacity: 0 !important;
        }
    `;
    document.documentElement.appendChild(style);
})();
