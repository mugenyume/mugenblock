import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock chrome API
const chromeMock = {
    runtime: {
        onInstalled: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() },
        onSuspend: { addListener: vi.fn() },
    },
    alarms: {
        onAlarm: { addListener: vi.fn() },
        create: vi.fn(),
    },
    tabs: {
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
    },
    storage: {
        local: {
            get: vi.fn().mockResolvedValue({}),
            set: vi.fn().mockResolvedValue(undefined),
        },
        onChanged: { addListener: vi.fn() },
    },
    permissions: {
        getAll: vi.fn().mockResolvedValue({ origins: [] }),
    },
    declarativeNetRequest: {
        updateSessionRules: vi.fn().mockResolvedValue(undefined),
        updateEnabledRulesets: vi.fn().mockResolvedValue(undefined),
    },
};

vi.stubGlobal('chrome', chromeMock);

// Mock setTimeout/setInterval
vi.useFakeTimers();

describe('ExtensionServiceWorker', () => {
    let worker: any;
    let ExtensionServiceWorker: any;

    beforeEach(async () => {
        vi.clearAllMocks();
        // Dynamic import to ensure chrome is stubbed first
        const mod = await import('../index');
        ExtensionServiceWorker = mod.ExtensionServiceWorker;
        worker = new ExtensionServiceWorker();
    });

    it('handleIncrementStats correctly updates totals', async () => {
        const sendResponse = vi.fn();
        const msg = { type: 'INCREMENT_STATS', key: 'cosmeticHides', count: 5 };
        const sender = { tab: { id: 123 } };

        worker.handleMessage(msg, sender, sendResponse);

        expect(sendResponse).toHaveBeenCalledWith({ ok: true });

        const statsResponse = vi.fn();
        worker.handleMessage({ type: 'GET_STATS' }, sender, statsResponse);

        expect(statsResponse).toHaveBeenCalledWith(
            expect.objectContaining({
                ok: true,
                stats: expect.objectContaining({
                    cosmeticHides: 5,
                    totalBlocked: 5,
                }),
                tabCount: 5,
            }),
        );
    });

    it('handleSetMode rejects invalid modes', async () => {
        const sendResponse = vi.fn();
        const msg = { type: 'SET_MODE', domain: 'example.com', mode: 'invalid' };

        worker.handleMessage(msg, {}, sendResponse);

        expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'INVALID_MODE' });
    });

    it('prunePerSiteCache respects limits', async () => {
        const sendResponse = vi.fn();
        // The limit is 500.
        for (let i = 0; i < 510; i++) {
            worker.handleMessage(
                {
                    type: 'SET_MODE',
                    domain: `site${i}.com`,
                    mode: 'standard',
                },
                {},
                sendResponse,
            );
        }

        expect(Object.keys(worker.perSiteCache).length).toBe(500);
    });
});
