import type { FilteringMode } from '@mugenblock/shared';

export class InteractionGuard {
    private isAdvanced = false;
    private onBlockCallback?: (count: number) => void;

    constructor() {}

    public start(mode: FilteringMode, onBlock?: (count: number) => void) {
        this.onBlockCallback = onBlock;
        this.isAdvanced = mode === 'advanced';
        this.setupClickProtection();
        this.setupVideoDefense();
    }

    private report(count: number) {
        if (this.onBlockCallback) this.onBlockCallback(count);
    }

    private setupClickProtection() {
        let interactionCount = 0;

        const handleInteraction = (e: Event) => {
            const target = e.target as HTMLElement;
            if (!target || !target.matches) return;

            if (e.type === 'click') {
                interactionCount++;
            }

            if (this.isAdvanced && interactionCount <= 1) {
                const isSafe = !!(
                    target.tagName === 'A' ||
                    target.tagName === 'BUTTON' ||
                    target.closest('a, button, input, select, textarea, [role="button"]')
                );

                if (!isSafe) {
                    const rect = target.getBoundingClientRect();
                    const isLarge = rect.width > window.innerWidth * 0.5 && rect.height > window.innerHeight * 0.5;

                    if (isLarge && !this.isLegitimateOverlay(target)) {
                        const style = window.getComputedStyle(target);
                        if (parseFloat(style.opacity) < 0.1 || target.innerText.trim().length === 0) {
                            e.stopImmediatePropagation();
                            e.preventDefault();
                            if (e.type === 'click') {
                                target.remove();
                                this.report(1);
                            }
                            return;
                        }
                    }
                }
            }

            if (e.type === 'click') {
                const style = target.getAttribute('style') || '';
                if (style.includes('position: fixed') || style.includes('position: absolute')) {
                    const zIndexString = window.getComputedStyle(target).zIndex;
                    const zIndex = parseInt(zIndexString);
                    if (zIndex > 100 || zIndexString === 'auto') {
                        const rect = target.getBoundingClientRect();
                        const isLarge = rect.width > window.innerWidth * 0.5 && rect.height > window.innerHeight * 0.5;

                        if (isLarge && !this.isLegitimateOverlay(target)) {
                            const cStyle = window.getComputedStyle(target);
                            if (parseFloat(cStyle.opacity) < 0.1 && target.innerText.trim().length === 0) {
                                e.preventDefault();
                                e.stopPropagation();
                                target.remove();
                                this.report(1);
                            }
                        }
                    }
                }
            }
        };

        document.addEventListener('click', handleInteraction, true);
        document.addEventListener('mousedown', handleInteraction, true);
        document.addEventListener('mouseup', handleInteraction, true);
    }

    private isLegitimateOverlay(el: HTMLElement): boolean {
        const whitelist = ['video', 'main', 'article', 'form', 'dialog', 'nav', 'header', 'footer', 'iframe'];
        const classWhitelist = ['plyr__', 'vjs-', 'ytp-', 'player-', 'control', 'button', 'loading', 'spinner'];

        const tag = el.tagName.toLowerCase();
        if (whitelist.includes(tag)) return true;

        const cls = el.className || '';
        if (typeof cls === 'string' && classWhitelist.some((w) => cls.includes(w))) return true;
        if (el.innerText.trim().length > 50) return true;

        return false;
    }

    private setupVideoDefense() {
        if (!this.isAdvanced) return;

        const handleVideo = (video: HTMLVideoElement) => {
            if (video.hasAttribute('data-mugen-protected')) return;
            video.setAttribute('data-mugen-protected', 'true');

            video.addEventListener('play', () => this.sweepVideo(video));
            video.addEventListener('pause', () => this.sweepVideo(video));
        };

        document.querySelectorAll('video').forEach((v) => handleVideo(v as HTMLVideoElement));

        const observer = new MutationObserver((mutations) => {
            for (const mut of mutations) {
                mut.addedNodes.forEach((node) => {
                    if (node instanceof HTMLVideoElement) {
                        handleVideo(node);
                    } else if (node instanceof HTMLElement) {
                        node.querySelectorAll('video').forEach((v) => handleVideo(v as HTMLVideoElement));
                    }
                });
            }
        });

        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    private sweepVideo(video: HTMLVideoElement) {
        const vRect = video.getBoundingClientRect();
        if (vRect.width < 100) return;

        const parent = video.closest('.plyr, .video-js, .jwplayer, [class*="player"], [class*="video"]');
        if (parent instanceof HTMLElement) {
            parent.querySelectorAll('iframe, div').forEach((el) => {
                const htmlEl = el as HTMLElement;
                if (this.isLegitimateOverlay(htmlEl)) return;

                const isIfr = htmlEl.tagName === 'IFRAME';
                const hasOffer =
                    isIfr &&
                    ((htmlEl as HTMLIFrameElement).title === 'offer' || htmlEl.getAttribute('scrolling') === 'no');

                if (
                    hasOffer ||
                    (htmlEl.children.length === 1 &&
                        htmlEl.innerText.trim().length === 0 &&
                        htmlEl.className.length > 50)
                ) {
                    htmlEl.style.setProperty('display', 'none', 'important');
                    this.report(1);
                }
            });

            const poster = parent.querySelector('.plyr__poster, [class*="poster"]');
            if (poster && !this.isLegitimateOverlay(poster as HTMLElement)) {
                poster.querySelectorAll('div, iframe').forEach((child) => {
                    const c = child as HTMLElement;
                    if (this.isLegitimateOverlay(c)) return;
                    if (c.style.position === 'absolute' && c.innerText.trim().length === 0) {
                        c.style.display = 'none';
                        this.report(1);
                    }
                });
            }
        }

        let checks = 0;
        const interval = setInterval(() => {
            checks++;
            if (checks > 10 || video.paused === false) {
                clearInterval(interval);
                return;
            }

            const potentialOverlays = document.querySelectorAll(
                'div[style*="position: absolute"], div[style*="position: fixed"]',
            );
            potentialOverlays.forEach((el) => {
                const oRect = el.getBoundingClientRect();
                const overlaps = !(
                    oRect.right < vRect.left ||
                    oRect.left > vRect.right ||
                    oRect.bottom < vRect.top ||
                    oRect.top > vRect.bottom
                );

                if (overlaps && !el.contains(video)) {
                    const htmlEl = el as HTMLElement;
                    if (
                        oRect.width < 400 &&
                        htmlEl.innerText.trim().length === 0 &&
                        !this.isLegitimateOverlay(htmlEl)
                    ) {
                        const style = window.getComputedStyle(htmlEl);
                        if (parseFloat(style.opacity) < 0.1) {
                            htmlEl.style.setProperty('display', 'none', 'important');
                            this.report(1);
                        }
                    }
                }
            });
        }, 1000);
    }
}
