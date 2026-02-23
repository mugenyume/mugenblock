
import React, { useEffect, useState, useCallback } from 'react';
import { FilteringMode, SiteSettings, StatsData, DEFAULT_SITE_SETTINGS, DEFAULT_STATS } from '@mugenblock/shared';

interface PopupState {
    domain: string;
    mode: FilteringMode;
    globalMode: FilteringMode;
    siteConfig: SiteSettings;
    stats: StatsData;
    statusText: string;
    isSystemPage: boolean;
    relaxCountdown: string | null;
    toast: string;
}

const Popup: React.FC = () => {
    const [state, setState] = useState<PopupState>({
        domain: '',
        mode: 'lite',
        globalMode: 'lite',
        siteConfig: { ...DEFAULT_SITE_SETTINGS },
        stats: { ...DEFAULT_STATS },
        statusText: 'Identifying Site...',
        isSystemPage: false,
        relaxCountdown: null,
        toast: '',
    });

    const showToast = useCallback((msg: string) => {
        setState(s => ({ ...s, toast: msg }));
        setTimeout(() => setState(s => ({ ...s, toast: '' })), 2000);
    }, []);

    // Single-read initialization — no polling
    useEffect(() => {
        (async () => {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab?.url) {
                    setState(s => ({ ...s, statusText: 'Access Restricted', isSystemPage: true }));
                    return;
                }

                const url = new URL(tab.url);
                const hostname = url.hostname;
                const isWeb = url.protocol === 'http:' || url.protocol === 'https:';

                if (!isWeb || !hostname) {
                    setState(s => ({
                        ...s,
                        domain: url.protocol.replace(':', '').toUpperCase(),
                        statusText: 'System Protection Active',
                        isSystemPage: true,
                    }));
                    return;
                }

                // Batch all data reads into parallel messages
                const [modeResult, statsResult, configResult] = await Promise.all([
                    new Promise<FilteringMode>(resolve =>
                        chrome.runtime.sendMessage({ type: 'GET_MODE', domain: hostname }, r => resolve(r || 'lite'))),
                    new Promise<StatsData>(resolve =>
                        chrome.runtime.sendMessage({ type: 'GET_STATS' }, r => resolve(r?.stats || DEFAULT_STATS))),
                    new Promise<any>(resolve =>
                        chrome.runtime.sendMessage({ type: 'GET_SITE_CONFIG', domain: hostname }, r => resolve(r || {}))),
                ]);

                const siteConfig: SiteSettings = configResult?.config || { ...DEFAULT_SITE_SETTINGS };
                const relaxUntil = siteConfig.relaxUntil;
                const isRelaxed = relaxUntil && Date.now() < relaxUntil;

                setState(s => ({
                    ...s,
                    domain: hostname,
                    mode: modeResult,
                    globalMode: configResult?.globalMode || 'lite',
                    siteConfig,
                    stats: statsResult,
                    statusText: isRelaxed ? '⏸ Relaxed Mode' : 'MugenBlock Active',
                    relaxCountdown: isRelaxed ? formatCountdown(relaxUntil!) : null,
                }));
            } catch {
                setState(s => ({ ...s, statusText: 'Wait for Page...' }));
            }
        })();
    }, []);

    // Countdown timer for relax mode
    useEffect(() => {
        if (!state.siteConfig.relaxUntil || Date.now() >= state.siteConfig.relaxUntil) return;
        const timer = setInterval(() => {
            const remaining = state.siteConfig.relaxUntil! - Date.now();
            if (remaining <= 0) {
                setState(s => ({ ...s, relaxCountdown: null, statusText: 'MugenBlock Active' }));
                clearInterval(timer);
            } else {
                setState(s => ({ ...s, relaxCountdown: formatCountdown(state.siteConfig.relaxUntil!) }));
            }
        }, 1000);
        return () => clearInterval(timer);
    }, [state.siteConfig.relaxUntil]);

    const handleModeChange = async (newMode: FilteringMode) => {
        if (state.isSystemPage || !state.domain) return;
        setState(s => ({ ...s, mode: newMode }));
        chrome.runtime.sendMessage(
            { type: 'SET_MODE', domain: state.domain, mode: newMode },
            (res) => { if (res?.ok) showToast(`Mode → ${newMode.toUpperCase()}`); }
        );
    };

    const handleToggle = (key: 'mainWorldOff' | 'cosmeticsOff' | 'siteFixesOff') => {
        if (state.isSystemPage || !state.domain) return;
        const newVal = !state.siteConfig[key];
        setState(s => ({
            ...s,
            siteConfig: { ...s.siteConfig, [key]: newVal },
        }));
        chrome.runtime.sendMessage({ type: 'SET_SITE_TOGGLE', domain: state.domain, key, value: newVal });
        showToast(`${formatToggleName(key)}: ${newVal ? 'OFF' : 'ON'}`);
    };

    const handleRelax = () => {
        if (state.isSystemPage || !state.domain) return;
        chrome.runtime.sendMessage(
            { type: 'TEMPORARY_RELAX', domain: state.domain, minutes: 30 },
            (res) => {
                if (res?.ok) {
                    setState(s => ({
                        ...s,
                        statusText: '⏸ Relaxed Mode',
                        relaxCountdown: '30:00',
                        siteConfig: { ...s.siteConfig, relaxUntil: res.relaxUntil },
                    }));
                    showToast('Relaxed for 30 minutes');
                }
            }
        );
    };

    const handleReport = () => {
        if (!state.domain) return;
        const report = {
            domain: state.domain,
            version: chrome.runtime.getManifest().version,
            mode: state.mode,
            siteConfig: state.siteConfig,
            stats: { totalBlocked: state.stats.totalBlocked },
            timestamp: new Date().toISOString(),
        };
        navigator.clipboard.writeText(JSON.stringify(report, null, 2));
        chrome.runtime.sendMessage({ type: 'REPORT_ISSUE', domain: state.domain, details: 'user-reported' });
        showToast('Report copied to clipboard');
    };

    const modeDescriptions: Record<FilteringMode, { label: string; desc: string }> = {
        lite: { label: 'Lite', desc: 'Network only' },
        standard: { label: 'Standard', desc: 'Balanced' },
        advanced: { label: 'Advanced', desc: 'Aggressive' },
    };

    return (
        <div className="popup-container">
            <header className="header-main">
                <div className="title-group">
                    <div className="logo-wrapper">
                        <img src="/icons/icon48.png" className="logo" alt="" />
                    </div>
                    <div className="title-meta">
                        <h1>MugenBlock</h1>
                        <span className="version">v{chrome.runtime.getManifest().version}</span>
                    </div>
                </div>
                <div className={`status-badge mode-${state.mode}`}>
                    <span className="pulse"></span>
                    {state.mode.toUpperCase()}
                </div>
            </header>

            <main className="content-scroll">
                <section className="stats-section">
                    <div className="stats-card">
                        <div className="stats-value">{state.stats.totalBlocked.toLocaleString()}</div>
                        <div className="stats-label">THREATS NEUTRALIZED</div>
                        <div className="stats-bar">
                            <div className="buffer-line" style={{ width: '100%' }}></div>
                        </div>
                    </div>
                </section>

                <section className="site-context">
                    <div className="context-box">
                        <div className="domain-pill">{state.domain || 'Detecting...'}</div>
                        <div className="status-indicator">
                            <span className={`dot ${state.isSystemPage ? 'sys' : 'active'}`}></span>
                            {state.statusText}
                        </div>
                        {state.relaxCountdown && (
                            <div className="relax-countdown">
                                <span className="icon">⏳</span> Auto-Shield in {state.relaxCountdown}
                            </div>
                        )}
                    </div>
                </section>

                <section className="selector-section">
                    <div className="section-title">PROTECTION LEVEL</div>
                    <div className="mode-grid">
                        {(['lite', 'standard', 'advanced'] as FilteringMode[]).map(m => (
                            <button
                                key={m}
                                disabled={state.isSystemPage}
                                className={`mode-option ${state.mode === m ? 'active' : ''}`}
                                onClick={() => handleModeChange(m)}
                            >
                                <div className="opt-label">{modeDescriptions[m].label}</div>
                                <div className="opt-desc">{modeDescriptions[m].desc}</div>
                            </button>
                        ))}
                    </div>
                </section>

                {!state.isSystemPage && state.mode !== 'lite' && (
                    <section className="toggles-section">
                        <div className="section-title">ACTIVE SHIELDS</div>
                        <div className="toggles-container">
                            <ToggleRow
                                label="Cosmetic Filtering"
                                active={!state.siteConfig.cosmeticsOff}
                                onChange={() => handleToggle('cosmeticsOff')}
                            />
                            <ToggleRow
                                label="Script Fixes"
                                active={!state.siteConfig.siteFixesOff}
                                onChange={() => handleToggle('siteFixesOff')}
                            />
                            {state.mode === 'advanced' && (
                                <ToggleRow
                                    label="Hyper Shield"
                                    active={!state.siteConfig.mainWorldOff}
                                    onChange={() => handleToggle('mainWorldOff')}
                                />
                            )}
                        </div>
                    </section>
                )}

                <section className="quick-actions">
                    {!state.isSystemPage && (
                        <div className="action-row">
                            <button className="btn btn-secondary" onClick={handleRelax} disabled={!!state.relaxCountdown}>
                                ⏸ Relax Shield
                            </button>
                            <button className="btn btn-danger" onClick={handleReport}>
                                ⚠ Report Breakage
                            </button>
                        </div>
                    )}
                </section>
            </main>

            <footer className="footer-bar">
                <button className="options-link" onClick={() => chrome.runtime.openOptionsPage()}>
                    Advanced Dashboard
                </button>
            </footer>

            {state.toast && <div className="glass-toast">{state.toast}</div>}
        </div>
    );
};

// ─── Sub-Components ──────────────────────────────────────────────────

const ToggleRow: React.FC<{ label: string; active: boolean; onChange: () => void }> = ({ label, active, onChange }) => (
    <div className={`tile-toggle ${active ? 'active' : ''}`} onClick={onChange}>
        <div className="toggle-info">
            <span className="toggle-label">{label}</span>
        </div>
        <div className={`ios-switch ${active ? 'on' : 'off'}`}>
            <div className="switch-handle" />
        </div>
    </div>
);

// ─── Helpers ─────────────────────────────────────────────────────────

function formatCountdown(until: number): string {
    const remaining = Math.max(0, until - Date.now());
    const mins = Math.floor(remaining / 60_000);
    const secs = Math.floor((remaining % 60_000) / 1000);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatToggleName(key: string): string {
    return key.replace('Off', '').replace(/([A-Z])/g, ' $1').trim();
}

export default Popup;
