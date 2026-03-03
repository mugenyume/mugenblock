(function () {
    'use strict';

    const GUARD_KEY = '__mugenSentinel';
    const CONFIG_EVENT = '__MUGEN_MAIN_WORLD_CONFIG__';
    const NEUTRALIZED_EVENT = '__MUGEN_NEUTRALIZED_EVENT__';

    if ((window as any)[GUARD_KEY]) return;
    (window as any)[GUARD_KEY] = true;

    if (location.protocol === 'about:' || location.protocol === 'chrome:' || window !== window.top) {
        return;
    }

    const SUSPICIOUS_PATTERNS = [
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

    let enabled = false;
    let installed = false;

    let lastInteractionAt = 0;
    let lastInteractionSafe = false;

    const originalOpen = window.open;

    let onPointerInteraction: ((event: MouseEvent) => void) | null = null;
    let onDocumentClick: ((event: MouseEvent) => void) | null = null;

    function isSafeElement(el: HTMLElement | null): boolean {
        if (!el) return false;

        const tag = el.tagName.toLowerCase();
        const isInteractive =
            ['a', 'button', 'input', 'select', 'textarea'].includes(tag) ||
            !!el.closest('a, button, input, select, textarea, [role="button"]');

        if (!isInteractive) return false;

        return el.innerText.trim().length > 0 || !!el.querySelector('svg, img');
    }

    function isSuspiciousUrl(url: string): boolean {
        const normalized = url.toLowerCase();
        return SUSPICIOUS_PATTERNS.some((pattern) => normalized.includes(pattern));
    }

    function shouldBlockPopup(url: string): boolean {
        if (!enabled || !url) return false;

        try {
            const parsed = new URL(url, location.href);

            if (parsed.hostname === location.hostname || parsed.hostname.endsWith(`.${location.hostname}`)) {
                return false;
            }

            if (!isSuspiciousUrl(parsed.href)) {
                return false;
            }

            const elapsed = Date.now() - lastInteractionAt;
            if (elapsed > 1_200 || !lastInteractionSafe) {
                return true;
            }

            return false;
        } catch {
            return true;
        }
    }

    function install(): void {
        if (installed) return;
        installed = true;

        window.open = function (url?: string | URL, target?: string, features?: string): Window | null {
            const nextUrl = typeof url === 'string' ? url : url?.toString() || '';

            if (shouldBlockPopup(nextUrl)) {
                window.dispatchEvent(
                    new CustomEvent(NEUTRALIZED_EVENT, {
                        detail: {
                            category: 'POP_PREVENT',
                            confidence: 'high',
                        },
                    }),
                );
                return null;
            }

            return originalOpen.call(window, url as any, target, features);
        };

        onPointerInteraction = (event: MouseEvent) => {
            const target = event.target as HTMLElement | null;
            lastInteractionAt = Date.now();
            lastInteractionSafe = isSafeElement(target);
        };

        onDocumentClick = (event: MouseEvent) => {
            if (!enabled) return;

            const target = event.target as HTMLElement | null;
            const anchor = target?.closest('a') as HTMLAnchorElement | null;
            if (!anchor || !anchor.href) return;

            if (!anchor.target || anchor.target !== '_blank') return;
            if (!shouldBlockPopup(anchor.href)) return;

            event.preventDefault();
            event.stopImmediatePropagation();
            window.dispatchEvent(
                new CustomEvent(NEUTRALIZED_EVENT, {
                    detail: {
                        category: 'POP_PREVENT',
                        confidence: 'high',
                    },
                }),
            );
        };

        window.addEventListener('mousedown', onPointerInteraction, { capture: true, passive: true });
        document.addEventListener('click', onDocumentClick, { capture: true });
    }

    function uninstall(): void {
        if (!installed) return;

        installed = false;
        window.open = originalOpen;

        if (onPointerInteraction) {
            window.removeEventListener('mousedown', onPointerInteraction, true);
            onPointerInteraction = null;
        }

        if (onDocumentClick) {
            document.removeEventListener('click', onDocumentClick, true);
            onDocumentClick = null;
        }

        lastInteractionAt = 0;
        lastInteractionSafe = false;
    }

    window.addEventListener(CONFIG_EVENT, (event: Event) => {
        const customEvent = event as CustomEvent<{ enabled?: boolean }>;
        const nextEnabled = Boolean(customEvent.detail?.enabled);

        if (nextEnabled) {
            install();
            enabled = true;
            return;
        }

        enabled = false;
        uninstall();
    });
})();
