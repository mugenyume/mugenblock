import type { FilteringMode } from '../types';

const VIDEO_SWEEP_DELAYS_MS = [120, 500, 1200];

export class InteractionGuard {
    private isAdvanced = false;
    private onOverlayFixCallback?: (count: number) => void;

    private clickHandler: ((event: Event) => void) | null = null;
    private videoObserver: MutationObserver | null = null;

    private videoListeners = new Map<HTMLVideoElement, { onPlay: () => void; onPause: () => void }>();
    private pendingSweepTimeouts = new Set<number>();
    private fixedOverlays = new WeakSet<HTMLElement>();

    public start(mode: FilteringMode, onOverlayFix?: (count: number) => void) {
        this.stop();

        this.onOverlayFixCallback = onOverlayFix;
        this.isAdvanced = mode === 'advanced';

        if (!this.isAdvanced) return;

        this.setupClickProtection();
        this.setupVideoDefense();
    }

    public stop() {
        if (this.clickHandler) {
            document.removeEventListener('click', this.clickHandler, true);
            document.removeEventListener('mousedown', this.clickHandler, true);
            document.removeEventListener('mouseup', this.clickHandler, true);
            this.clickHandler = null;
        }

        if (this.videoObserver) {
            this.videoObserver.disconnect();
            this.videoObserver = null;
        }

        for (const timeoutId of this.pendingSweepTimeouts) {
            clearTimeout(timeoutId);
        }
        this.pendingSweepTimeouts.clear();

        for (const [video, handlers] of this.videoListeners.entries()) {
            video.removeEventListener('play', handlers.onPlay);
            video.removeEventListener('pause', handlers.onPause);
            video.removeAttribute('data-mugen-protected');
        }
        this.videoListeners.clear();
        this.fixedOverlays = new WeakSet<HTMLElement>();
    }

    public destroy(): void {
        this.stop();
        this.onOverlayFixCallback = undefined;
        this.isAdvanced = false;
    }

    private reportOverlayFix(count: number) {
        if (this.onOverlayFixCallback) {
            this.onOverlayFixCallback(count);
        }
    }

    private hasModalDialogOpen(): boolean {
        return Boolean(document.querySelector('dialog[open], [role="dialog"][aria-modal="true"], .modal[open]'));
    }

    private hasScrollLockOverlay(trigger?: HTMLElement): boolean {
        const lockActive = [document.documentElement, document.body].some((node) => {
            if (!node) return false;
            const style = window.getComputedStyle(node);
            return style.overflow === 'hidden' || style.overflowY === 'hidden';
        });

        if (!lockActive) return false;
        if (this.hasModalDialogOpen()) return false;

        if (trigger) {
            const rect = trigger.getBoundingClientRect();
            const style = window.getComputedStyle(trigger);
            const largeOverlay = rect.width >= window.innerWidth * 0.45 && rect.height >= window.innerHeight * 0.45;
            const overlayLike = style.position === 'fixed' || style.position === 'absolute';
            if (largeOverlay && overlayLike) {
                return true;
            }
        }

        const fallbackOverlay = document.querySelector(
            '[data-overlay], [class*="overlay"], [class*="backdrop"], [class*="modal"][open]',
        );
        if (!(fallbackOverlay instanceof HTMLElement)) return false;

        const rect = fallbackOverlay.getBoundingClientRect();
        const style = window.getComputedStyle(fallbackOverlay);
        return (
            (style.position === 'fixed' || style.position === 'absolute') &&
            rect.width >= window.innerWidth * 0.4 &&
            rect.height >= window.innerHeight * 0.3
        );
    }

    private tryRestoreScroll(allowRestore: boolean) {
        if (!allowRestore) return;
        if (this.hasModalDialogOpen()) {
            return;
        }

        const targets = [document.documentElement, document.body];
        for (const node of targets) {
            if (!node) continue;
            const style = window.getComputedStyle(node);
            const lockActive = style.overflow === 'hidden' || style.overflowY === 'hidden';
            if (lockActive) {
                node.style.setProperty('overflow', 'auto', 'important');
                node.style.setProperty('overflow-y', 'auto', 'important');
            }
        }
    }

    private setupClickProtection() {
        let interactionCount = 0;

        this.clickHandler = (event: Event) => {
            const target = event.target as HTMLElement | null;
            if (!target || !target.matches) return;

            if (event.type === 'click') {
                interactionCount += 1;
            }

            const isSafeTarget = Boolean(
                target.tagName === 'A' ||
                    target.tagName === 'BUTTON' ||
                    target.closest('a, button, input, select, textarea, [role="button"]'),
            );

            if (interactionCount <= 1 && !isSafeTarget) {
                const rect = target.getBoundingClientRect();
                const isLarge = rect.width > window.innerWidth * 0.5 && rect.height > window.innerHeight * 0.5;

                if (isLarge && !this.isLegitimateOverlay(target)) {
                    const style = window.getComputedStyle(target);
                    const hasContent = target.innerText.trim().length > 0;
                    const lowOpacity = parseFloat(style.opacity) < 0.1;

                    if (lowOpacity || !hasContent) {
                        event.preventDefault();
                        event.stopImmediatePropagation();

                        if (event.type === 'click') {
                            this.fixedOverlays.add(target);
                            const shouldRestoreScroll = this.hasScrollLockOverlay(target);
                            target.style.setProperty('display', 'none', 'important');
                            target.style.setProperty('pointer-events', 'none', 'important');
                            this.tryRestoreScroll(shouldRestoreScroll);
                            this.reportOverlayFix(1);
                        }
                    }
                }
            }
        };

        document.addEventListener('click', this.clickHandler, true);
        document.addEventListener('mousedown', this.clickHandler, true);
        document.addEventListener('mouseup', this.clickHandler, true);
    }

    private setupVideoDefense() {
        const observeVideo = (video: HTMLVideoElement) => {
            if (this.videoListeners.has(video)) return;

            const schedule = () => this.scheduleVideoSweeps(video);
            const handlers = {
                onPlay: schedule,
                onPause: schedule,
            };

            this.videoListeners.set(video, handlers);
            video.setAttribute('data-mugen-protected', 'true');
            video.addEventListener('play', handlers.onPlay);
            video.addEventListener('pause', handlers.onPause);
        };

        document.querySelectorAll('video').forEach((video) => observeVideo(video as HTMLVideoElement));

        this.videoObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                mutation.addedNodes.forEach((node) => {
                    if (node instanceof HTMLVideoElement) {
                        observeVideo(node);
                        return;
                    }

                    if (node instanceof HTMLElement) {
                        node.querySelectorAll('video').forEach((video) => observeVideo(video as HTMLVideoElement));
                    }
                });
            }
        });

        this.videoObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    private scheduleVideoSweeps(video: HTMLVideoElement): void {
        VIDEO_SWEEP_DELAYS_MS.forEach((delay) => {
            const timeoutId = window.setTimeout(() => {
                this.pendingSweepTimeouts.delete(timeoutId);

                if (!video.isConnected) return;
                this.sweepVideo(video);
            }, delay);

            this.pendingSweepTimeouts.add(timeoutId);
        });
    }

    private sweepVideo(video: HTMLVideoElement) {
        const videoRect = video.getBoundingClientRect();
        if (videoRect.width < 100 || videoRect.height < 80) return;

        const parent = video.closest('.plyr, .video-js, .jwplayer, [class*="player"], [class*="video"]');
        if (!(parent instanceof HTMLElement)) return;

        parent.querySelectorAll('iframe, div').forEach((candidate) => {
            const el = candidate as HTMLElement;
            if (this.fixedOverlays.has(el)) return;
            if (this.isLegitimateOverlay(el)) return;

            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;

            const overlaps = !(
                rect.right < videoRect.left ||
                rect.left > videoRect.right ||
                rect.bottom < videoRect.top ||
                rect.top > videoRect.bottom
            );

            if (!overlaps) return;

            const style = window.getComputedStyle(el);
            const lowOpacity = parseFloat(style.opacity) < 0.1;
            const emptyish = el.innerText.trim().length === 0 && el.children.length <= 1;

            if (lowOpacity && emptyish) {
                this.fixedOverlays.add(el);
                const shouldRestoreScroll = this.hasScrollLockOverlay(el);
                el.style.setProperty('display', 'none', 'important');
                this.tryRestoreScroll(shouldRestoreScroll);
                this.reportOverlayFix(1);
            }
        });
    }

    private isLegitimateOverlay(el: HTMLElement): boolean {
        const tagWhitelist = ['video', 'main', 'article', 'form', 'dialog', 'nav', 'header', 'footer', 'iframe'];
        const classWhitelist = ['plyr__', 'vjs-', 'ytp-', 'player-', 'control', 'button', 'loading', 'spinner'];

        const tag = el.tagName.toLowerCase();
        if (tagWhitelist.includes(tag)) return true;

        const cls = typeof el.className === 'string' ? el.className : '';
        if (classWhitelist.some((needle) => cls.includes(needle))) return true;

        return el.innerText.trim().length > 50;
    }
}
