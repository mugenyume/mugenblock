import { HeuristicsEngine } from './Heuristics';
import type { FilteringMode } from '../types';

const FRAME_BUDGET_MS = 8;
const IDLE_BUDGET_MS = 8;
const FRAME_BATCH_SIZE = 48;
const IDLE_QUEUE_BATCH_SIZE = 24;
const IDLE_BATCH_SIZE = 32;
const MAX_MUTATION_QUEUE = 400;
const MAX_CHILD_RECURSION = 12;
const PERF_SAMPLE_WINDOW = 80;
const DEFAULT_ATTRIBUTE_FILTER = ['class', 'style', 'hidden', 'aria-hidden', 'data-element', 'data-izone'];

type IdleCallback = (deadline: IdleDeadline) => void;
type BlockDelta = { cosHide: number; cosRemove: number };

export interface MutationProcessorOptions {
    hideFastMatchesOnly?: boolean;
    removalConfidenceThreshold?: number;
}

function scheduleIdle(callback: IdleCallback, timeout = 120): number {
    if (typeof requestIdleCallback === 'function') {
        return requestIdleCallback(callback, { timeout });
    }

    return window.setTimeout(() => {
        callback({
            didTimeout: true,
            timeRemaining: () => 0,
        } as IdleDeadline);
    }, Math.min(timeout, 16));
}

function cancelScheduledIdle(id: number): void {
    if (typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(id);
        return;
    }

    clearTimeout(id);
}

function scheduleFrame(callback: FrameRequestCallback): number {
    if (typeof requestAnimationFrame === 'function') {
        return requestAnimationFrame(callback);
    }

    return window.setTimeout(() => callback(performance.now()), 16);
}

function cancelScheduledFrame(id: number): void {
    if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(id);
        return;
    }

    clearTimeout(id);
}

export class MutationProcessor {
    private observer: MutationObserver | null = null;
    private processedNodes: WeakSet<Node> = new WeakSet();

    private mutationQueue: HTMLElement[] = [];
    private queuedNodes = new Set<HTMLElement>();

    private removalQueue: HTMLElement[] = [];

    private processingFrameId: number | null = null;
    private processingIdleId: number | null = null;
    private removalIdleId: number | null = null;
    private isProcessing = false;

    private onBlockCallback?: (delta: BlockDelta) => void;

    private currentMode: FilteringMode = 'lite';
    private currentFastSelector = '';
    private hideFastMatchesOnly = false;
    private removalConfidenceThreshold = 0.9;

    private callbackSamples: number[] = [];

    constructor(private heuristics: HeuristicsEngine) {}

    public start(
        mode: FilteringMode,
        fastSelector: string,
        optionsOrOnBlock?: MutationProcessorOptions | ((delta: BlockDelta) => void),
        onBlock?: (delta: BlockDelta) => void,
    ) {
        let options: MutationProcessorOptions | undefined;
        if (typeof optionsOrOnBlock === 'function') {
            this.onBlockCallback = optionsOrOnBlock;
        } else {
            options = optionsOrOnBlock;
            this.onBlockCallback = onBlock;
        }

        this.currentMode = mode;
        this.currentFastSelector = fastSelector;
        this.applyOptions(options);

        if (this.observer) return;

        this.observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach((node) => {
                        if (node instanceof HTMLElement) {
                            this.enqueueNode(node);
                        }
                    });
                } else if (mutation.type === 'attributes' && mutation.target instanceof HTMLElement) {
                    this.enqueueNode(mutation.target);
                }
            }

            this.scheduleProcessing();
        });

        this.observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: DEFAULT_ATTRIBUTE_FILTER,
        });
    }

    public stop() {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }

        if (this.processingFrameId !== null) {
            cancelScheduledFrame(this.processingFrameId);
            this.processingFrameId = null;
        }

        if (this.processingIdleId !== null) {
            cancelScheduledIdle(this.processingIdleId);
            this.processingIdleId = null;
        }

        if (this.removalIdleId !== null) {
            cancelScheduledIdle(this.removalIdleId);
            this.removalIdleId = null;
        }

        this.mutationQueue = [];
        this.queuedNodes.clear();
        this.removalQueue = [];
        this.onBlockCallback = undefined;
    }

    public destroy(): void {
        this.stop();
        this.processedNodes = new WeakSet();
        this.onBlockCallback = undefined;
        this.callbackSamples = [];
    }

    public getObserverP95Ms(): number {
        if (this.callbackSamples.length === 0) return 0;
        const sorted = [...this.callbackSamples].sort((a, b) => a - b);
        const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
        return sorted[index];
    }

    private enqueueNode(node: HTMLElement): void {
        if (!node.isConnected) return;
        if (this.processedNodes.has(node)) return;
        if (this.queuedNodes.has(node)) return;

        if (this.mutationQueue.length >= MAX_MUTATION_QUEUE) {
            const dropped = this.mutationQueue.shift();
            if (dropped) {
                this.queuedNodes.delete(dropped);
            }
        }

        this.mutationQueue.push(node);
        this.queuedNodes.add(node);
    }

    private applyOptions(options: MutationProcessorOptions | undefined): void {
        this.hideFastMatchesOnly = Boolean(options?.hideFastMatchesOnly);

        const rawThreshold = options?.removalConfidenceThreshold;
        if (typeof rawThreshold === 'number' && Number.isFinite(rawThreshold)) {
            this.removalConfidenceThreshold = Math.max(0.5, Math.min(1, rawThreshold));
            return;
        }

        this.removalConfidenceThreshold = 0.9;
    }

    private scheduleProcessing(): void {
        if (this.mutationQueue.length === 0) return;

        if (this.processingFrameId === null) {
            this.processingFrameId = scheduleFrame(() => {
                this.processingFrameId = null;
                this.processQueueSlice(FRAME_BATCH_SIZE, FRAME_BUDGET_MS);
                if (this.mutationQueue.length > 0) {
                    this.scheduleProcessing();
                }
            });
        }

        if (this.processingIdleId !== null) return;

        this.processingIdleId = scheduleIdle((deadline) => {
            this.processingIdleId = null;
            if (!deadline.didTimeout && deadline.timeRemaining() <= 0) {
                this.scheduleProcessing();
                return;
            }

            this.processQueueSlice(IDLE_QUEUE_BATCH_SIZE, IDLE_BUDGET_MS, deadline);
            if (this.mutationQueue.length > 0) {
                this.scheduleProcessing();
            }
        });
    }

    private recordCallbackDuration(ms: number): void {
        this.callbackSamples.push(ms);
        if (this.callbackSamples.length > PERF_SAMPLE_WINDOW) {
            this.callbackSamples.shift();
        }
    }

    private processQueueSlice(maxNodes: number, budgetMs: number, idleDeadline?: IdleDeadline): void {
        if (this.isProcessing || this.mutationQueue.length === 0) return;

        this.isProcessing = true;
        const totals = { cosHide: 0, cosRemove: 0 };
        const start = performance.now();

        try {
            let processed = 0;
            while (this.mutationQueue.length > 0) {
                if (processed >= maxNodes) break;
                if (performance.now() - start >= budgetMs) break;
                if (idleDeadline && !idleDeadline.didTimeout && idleDeadline.timeRemaining() <= 1) break;

                const node = this.mutationQueue.shift();
                if (!node) break;

                this.queuedNodes.delete(node);

                if (!node.isConnected || this.processedNodes.has(node)) continue;

                const delta = this.analyzeAndHide(node, this.currentMode, this.currentFastSelector);
                totals.cosHide += delta.cosHide;
                totals.cosRemove += delta.cosRemove;
                processed += 1;
            }
        } finally {
            this.isProcessing = false;
        }

        const elapsed = performance.now() - start;
        this.recordCallbackDuration(elapsed);

        if ((totals.cosHide > 0 || totals.cosRemove > 0) && this.onBlockCallback) {
            this.onBlockCallback(totals);
        }
    }

    public analyzeAndHide(
        node: HTMLElement,
        mode: FilteringMode,
        fastSelector: string,
    ): { cosHide: number; cosRemove: number } {
        return this.analyzeAndHideRecursive(node, mode, fastSelector, 0);
    }

    private analyzeAndHideRecursive(
        node: HTMLElement,
        mode: FilteringMode,
        fastSelector: string,
        depth: number,
    ): { cosHide: number; cosRemove: number } {
        if (this.processedNodes.has(node)) return { cosHide: 0, cosRemove: 0 };

        try {
            if (fastSelector && node.matches(fastSelector)) {
                if (this.hideFastMatchesOnly) {
                    this.hideOnly(node);
                    return { cosHide: 1, cosRemove: 0 };
                }

                this.hideThenRemove(node);
                return { cosHide: 0, cosRemove: 1 };
            }
        } catch {
            // Ignore invalid selector edge-cases.
        }

        const result = this.heuristics.analyzeNode(node, mode);
        if (result.isAd) {
            if (result.confidence >= this.removalConfidenceThreshold) {
                this.hideThenRemove(node);
                return { cosHide: 0, cosRemove: 1 };
            }

            this.hideOnly(node);
            return { cosHide: 1, cosRemove: 0 };
        }

        if (depth >= 2 || node.children.length === 0 || node.children.length > MAX_CHILD_RECURSION) {
            return { cosHide: 0, cosRemove: 0 };
        }

        const totals = { cosHide: 0, cosRemove: 0 };
        for (const child of Array.from(node.children)) {
            if (!(child instanceof HTMLElement)) continue;
            const delta = this.analyzeAndHideRecursive(child, mode, fastSelector, depth + 1);
            totals.cosHide += delta.cosHide;
            totals.cosRemove += delta.cosRemove;
        }

        return totals;
    }

    private hideOnly(el: HTMLElement): void {
        this.processedNodes.add(el);

        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('pointer-events', 'none', 'important');
    }

    private hideThenRemove(el: HTMLElement): void {
        this.hideOnly(el);

        this.removalQueue.push(el);
        this.scheduleRemovalFlush();
    }

    private scheduleRemovalFlush(): void {
        if (this.removalIdleId !== null || this.removalQueue.length === 0) return;

        this.removalIdleId = scheduleIdle(() => {
            this.removalIdleId = null;

            let processed = 0;
            while (processed < IDLE_BATCH_SIZE && this.removalQueue.length > 0) {
                const node = this.removalQueue.shift();
                if (node?.isConnected) {
                    try {
                        node.remove();
                    } catch {
                        // Ignore transient DOM removal failures.
                    }
                }
                processed += 1;
            }

            if (this.removalQueue.length > 0) {
                this.scheduleRemovalFlush();
            }
        });
    }
}
