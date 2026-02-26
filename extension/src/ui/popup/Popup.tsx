import { withTimeout } from '../utils';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { FilteringMode, SiteSettings, StatsData, DEFAULT_SITE_SETTINGS, DEFAULT_STATS } from '@mugenblock/shared';

interface PopupState {
    domain: string;
    mode: FilteringMode;
    siteConfig: SiteSettings;
    stats: StatsData;
    isSystemPage: boolean;
    status: 'idle' | 'syncing' | 'error';
    toast: string;
}

const Popup: React.FC = () => {
    const [state, setState] = useState<PopupState>({
        domain: '',
        mode: 'lite',
        siteConfig: { ...DEFAULT_SITE_SETTINGS },
        stats: { ...DEFAULT_STATS },
        isSystemPage: false,
        status: 'syncing',
        toast: '',
    });

    const showToast = useCallback((msg: string) => {
        setState((s) => ({ ...s, toast: msg }));
        setTimeout(() => setState((s) => ({ ...s, toast: '' })), 2000);
    }, []);

    useEffect(() => {
        let currentDomain = '';

        const init = async () => {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab?.url) return;

                const url = new URL(tab.url);
                const domain = url.hostname;
                currentDomain = domain;
                const isWeb = url.protocol.startsWith('http');

                if (!isWeb) {
                    setState((s) => ({ ...s, isSystemPage: true, domain: 'System', status: 'idle' }));
                    return;
                }

                // 1. Instant Load: Read from storage cache immediately (Stale-While-Revalidate)
                const cached = await chrome.storage.local.get(['perSite', 'settings', 'stats']);
                const siteConfig = cached.perSite?.[domain] || { ...DEFAULT_SITE_SETTINGS };

                setState((s) => ({
                    ...s,
                    domain,
                    mode: siteConfig.mode || cached.settings?.mode || 'lite',
                    siteConfig,
                    stats: cached.stats || DEFAULT_STATS,
                    status: 'idle',
                }));

                // 2. Revalidate: Fetch fresh data from background
                const [modeResult, freshStats, freshConfig] = await Promise.all([
                    withTimeout(
                        new Promise<FilteringMode>((res) =>
                            chrome.runtime.sendMessage({ type: 'GET_MODE', domain }, res),
                        ),
                        1000,
                        null,
                    ),
                    withTimeout(
                        new Promise<any>((res) => chrome.runtime.sendMessage({ type: 'GET_STATS' }, res)),
                        1000,
                        null,
                    ),
                    withTimeout(
                        new Promise<any>((res) => chrome.runtime.sendMessage({ type: 'GET_SITE_CONFIG', domain }, res)),
                        1000,
                        null,
                    ),
                ]);

                if (modeResult) {
                    setState((s) => ({
                        ...s,
                        mode: modeResult as FilteringMode,
                        stats: freshStats?.stats || s.stats,
                        siteConfig: freshConfig?.config || s.siteConfig,
                    }));
                }
            } catch (e) {
                console.warn('[Mugen] Sync failed, using cache');
            }
        };

        // Real-time stats listener
        const statsListener = (changes: any, area: string) => {
            if (area === 'local' && changes.stats?.newValue) {
                setState((s) => ({
                    ...s,
                    stats: changes.stats.newValue,
                }));
            }
        };

        init();

        // Listen for stats updates in real-time
        chrome.storage.onChanged.addListener(statsListener);

        return () => {
            chrome.storage.onChanged.removeListener(statsListener);
        };
    }, []);

    const handleModeChange = (mode: FilteringMode) => {
        setState((s) => ({ ...s, mode }));
        chrome.runtime.sendMessage({ type: 'SET_MODE', domain: state.domain, mode });
        showToast(`Mode: ${mode.toUpperCase()}`);
    };

    const handleToggle = (key: 'mainWorldOff' | 'cosmeticsOff' | 'siteFixesOff') => {
        const newVal = !state.siteConfig[key];
        setState((s) => ({
            ...s,
            siteConfig: { ...s.siteConfig, [key]: newVal },
        }));
        chrome.runtime.sendMessage({ type: 'SET_SITE_TOGGLE', domain: state.domain, key, value: newVal });
    };

    const statsDisplay = useMemo(() => {
        return state.stats.totalBlocked.toLocaleString();
    }, [state.stats.totalBlocked]);

    if (state.isSystemPage) {
        return (
            <div className="popup-container system-page">
                <div className="minimal-header">
                    <span className="logo-text">MUGEN</span>
                </div>
                <div className="centered-content">
                    <div className="shield-icon disabled">🛡</div>
                    <p>Protection inactive on system pages.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="popup-container">
            <header className="avant-header">
                <div className="brand">
                    <span className="logo-dot"></span>
                    <span className="logo-text">MUGEN</span>
                </div>
                <div className="status-indicator">
                    <span className={`pulse ${state.status}`}></span>
                    {state.mode.toUpperCase()}
                </div>
            </header>

            <main className="minimal-main">
                <div className="hero-stats">
                    <span className="label">NEUTRALIZED</span>
                    <h2 className="count">{statsDisplay}</h2>
                </div>

                <div className="asymmetric-grid">
                    <div className="domain-info">
                        <span className="label">SITE</span>
                        <div className="domain-text">{state.domain}</div>
                    </div>
                </div>

                <div className="controls-section">
                    <div className="mode-selector-bespoke">
                        {(['lite', 'standard', 'advanced'] as FilteringMode[]).map((m) => (
                            <button
                                key={m}
                                className={`mode-btn ${state.mode === m ? 'active' : ''}`}
                                onClick={() => handleModeChange(m)}
                            >
                                {m.charAt(0).toUpperCase() + m.slice(1)}
                            </button>
                        ))}
                    </div>

                    {state.mode !== 'lite' && (
                        <div className="toggles-minimal">
                            <MinimalToggle
                                label="Cosmetic Shield"
                                active={!state.siteConfig.cosmeticsOff}
                                onClick={() => handleToggle('cosmeticsOff')}
                            />
                            <MinimalToggle
                                label="Script Guard"
                                active={!state.siteConfig.siteFixesOff}
                                onClick={() => handleToggle('siteFixesOff')}
                            />
                        </div>
                    )}
                </div>

                <div className="footer-actions">
                    <button className="dashboard-trigger" onClick={() => chrome.runtime.openOptionsPage()}>
                        DASHBOARD →
                    </button>
                </div>
            </main>

            {state.toast && <div className="avant-toast">{state.toast}</div>}
        </div>
    );
};

const MinimalToggle: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({
    label,
    active,
    onClick,
}) => (
    <div
        className={`minimal-toggle-row ${active ? 'active' : ''}`}
        onClick={onClick}
        role="switch"
        aria-checked={active}
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClick()}
    >
        <span className="toggle-label">{label}</span>
        <div className="toggle-dot"></div>
    </div>
);

export default Popup;
