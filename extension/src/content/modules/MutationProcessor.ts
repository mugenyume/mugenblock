import { HeuristicsEngine } from './Heuristics';
import type { FilteringMode } from '@mugenblock/shared';

const OBSERVER_BUDGET_MS = 6; // Tightened budget for better responsiveness
const IDLE_BATCH_SIZE = 40;

export class MutationProcessor {
    private observer: MutationObserver | null = null;
    private processedNodes: WeakSet<Node> = new WeakSet();
    private removalQueue: HTMLElement[] = [];
    private pendingIdleTask = false;

    constructor(private heuristics: HeuristicsEngine) {}

    private onBlockCallback?: (count: number) => void;

    public start(mode: FilteringMode, fastSelector: string, onBlock?: (count: number) => void) {
        this.onBlockCallback = onBlock;
        if (this.observer) return;

        this.observer = new MutationObserver((mutations) => {
            const targets: HTMLElement[] = [];
            for (const mut of mutations) {
                if (mut.type === 'childList') {
                    mut.addedNodes.forEach((node) => {
                        if (node instanceof HTMLElement) targets.push(node);
                    });
                } else if (mut.type === 'attributes' && mut.target instanceof HTMLElement) {
                    targets.push(mut.target);
                }
            }

            if (targets.length === 0) return;

            if (!this.pendingIdleTask) {
                this.pendingIdleTask = true;
                requestIdleCallback(
                    () => {
                        const initialCount = this.processBatch(targets, mode, fastSelector);
                        if (initialCount > 0 && this.onBlockCallback) {
                            this.onBlockCallback(initialCount);
                        }
                        this.pendingIdleTask = false;
                    },
                    { timeout: 150 },
                );
            }
        });

        this.observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'data-element', 'data-izone'],
        });
    }

    public stop() {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
    }

    private processBatch(nodes: HTMLElement[], mode: FilteringMode, fastSelector: string): number {
        let hiddenCount = 0;
        const deadline = performance.now() + OBSERVER_BUDGET_MS;

        for (let i = 0; i < nodes.length; i++) {
            if (performance.now() > deadline && i < nodes.length - 1) {
                const remaining = nodes.slice(i);
                requestIdleCallback(() => this.processBatch(remaining, mode, fastSelector));
                break;
            }

            const node = nodes[i];
            if (!node || !node.isConnected || this.processedNodes.has(node)) continue;

            const wasHidden = this.analyzeAndHide(node, mode, fastSelector);
            if (wasHidden) hiddenCount++;
        }
        return hiddenCount;
    }

    public analyzeAndHide(node: HTMLElement, mode: FilteringMode, fastSelector: string): boolean {
        if (this.processedNodes.has(node)) return false;

        // 1. Fast path: selector match
        try {
            if (fastSelector && node.matches(fastSelector)) {
                this.markAndQueue(node);
                return true;
            }
        } catch {}

        // 2. Heuristic path
        const result = this.heuristics.analyzeNode(node, mode);
        if (result.isAd) {
            this.markAndQueue(node);
            return true;
        }

        // 3. Recursive check for small children counts
        // Only recurse if the current node wasn't an ad itself
        let foundAnyChildAd = false;
        if (node.children.length > 0 && node.children.length < 15) {
            const children = Array.from(node.children);
            for (const child of children) {
                if (child instanceof HTMLElement) {
                    if (this.analyzeAndHide(child, mode, fastSelector)) {
                        foundAnyChildAd = true;
                    }
                }
            }
        }
        return foundAnyChildAd;
    }

    private markAndQueue(el: HTMLElement) {
        this.processedNodes.add(el);
        // Instant visual hide via style (no reflow if using opacity/visibility,
        // but display:none is safer for ad containers)
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('pointer-events', 'none', 'important');
        this.removalQueue.push(el);

        if (this.removalQueue.length >= IDLE_BATCH_SIZE) {
            this.flushRemovalQueue();
        }
    }

    private flushRemovalQueue() {
        requestIdleCallback(() => {
            let processed = 0;
            while (this.removalQueue.length > 0 && processed < IDLE_BATCH_SIZE) {
                const el = this.removalQueue.shift();
                if (el && el.isConnected) {
                    try {
                        el.remove();
                    } catch {}
                }
                processed++;
            }
            if (this.removalQueue.length > 0) this.flushRemovalQueue();
        });
    }
}
