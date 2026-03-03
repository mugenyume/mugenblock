import { withTimeout } from '../utils';
import { t, tMode } from '../i18n';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
    FilteringMode,
    SiteSettings,
    StatsData,
    NeutralizedCounters,
    DEFAULT_SITE_SETTINGS,
    DEFAULT_STATS,
} from '@mugenblock/shared';

const EMPTY_NEUTRALIZED: NeutralizedCounters = {
    netBlock: 0,
    cosHide: 0,
    cosRemove: 0,
    popPrevent: 0,
    overlayFix: 0,
    other: 0,
    weighted: 0,
};

interface PopupState {
    domain: string;
    mode: FilteringMode;
    siteConfig: SiteSettings;
    stats: StatsData;
    domainNeutralized: NeutralizedCounters;
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
        domainNeutralized: { ...EMPTY_NEUTRALIZED },
        isSystemPage: false,
        status: 'syncing',
        toast: '',
    });

    const showToast = useCallback((msg: string) => {
        setState((s) => ({ ...s, toast: msg }));
        setTimeout(() => setState((s) => ({ ...s, toast: '' })), 2000);
    }, []);

    useEffect(() => {
        const init = async () => {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab?.url) return;

                const url = new URL(tab.url);
                const domain = url.hostname;
                const isWeb = url.protocol.startsWith('http');

                if (!isWeb) {
                    setState((s) => ({ ...s, isSystemPage: true, domain: t('system_page_title'), status: 'idle' }));
                    return;
                }

                const cached = await chrome.storage.local.get(['perSite', 'settings', 'stats']);
                const siteConfig = cached.perSite?.[domain] || { ...DEFAULT_SITE_SETTINGS };
                const cachedDomainStats = cached.stats?.neutralized?.byDomain?.[domain] || EMPTY_NEUTRALIZED;

                setState((s) => ({
                    ...s,
                    domain,
                    mode: siteConfig.mode || cached.settings?.mode || 'lite',
                    siteConfig,
                    stats: cached.stats || DEFAULT_STATS,
                    domainNeutralized: cachedDomainStats,
                    status: 'idle',
                }));

                const [modeResult, freshDomainStats, freshConfig] = await Promise.all([
                    withTimeout(
                        new Promise<FilteringMode>((res) =>
                            chrome.runtime.sendMessage({ type: 'GET_MODE', domain }, res),
                        ),
                        1000,
                        null,
                    ),
                    withTimeout(
                        new Promise<any>((res) => chrome.runtime.sendMessage({ type: 'GET_DOMAIN_STATS', domain, tabId: tab.id }, res)),
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
                        siteConfig: freshConfig?.config || s.siteConfig,
                        domainNeutralized: freshDomainStats?.stats || s.domainNeutralized,
                    }));
                }
            } catch {
                // Fall back to cached state silently.
            }
        };

        const statsListener = (changes: any, area: string) => {
            if (area === 'local' && changes.stats?.newValue) {
                setState((s) => ({
                    ...s,
                    stats: changes.stats.newValue,
                    domainNeutralized: s.domain
                        ? changes.stats.newValue?.neutralized?.byDomain?.[s.domain] || s.domainNeutralized
                        : s.domainNeutralized,
                }));
            }
        };

        init();
        chrome.storage.onChanged.addListener(statsListener);

        return () => {
            chrome.storage.onChanged.removeListener(statsListener);
        };
    }, []);

    const handleModeChange = (mode: FilteringMode) => {
        if (!state.domain || state.siteConfig.disabled) return;

        setState((s) => ({ ...s, mode }));
        chrome.runtime.sendMessage({ type: 'SET_MODE', domain: state.domain, mode }, (response) => {
            if (chrome.runtime.lastError || !response?.ok) {
                showToast(t('toast_mode_failed'));
                return;
            }
            showToast(t('toast_mode', tMode(mode)));
        });
    };

    const handleToggle = (key: 'mainWorldOff' | 'cosmeticsOff' | 'siteFixesOff') => {
        if (!state.domain || state.siteConfig.disabled) return;

        const newVal = !state.siteConfig[key];
        setState((s) => ({
            ...s,
            siteConfig: { ...s.siteConfig, [key]: newVal },
        }));
        chrome.runtime.sendMessage({ type: 'SET_SITE_TOGGLE', domain: state.domain, key, value: newVal });
    };

    const handleSiteDisableToggle = () => {
        const nextDisabled = !state.siteConfig.disabled;
        chrome.runtime.sendMessage(
            { type: 'SET_SITE_DISABLED', domain: state.domain, disabled: nextDisabled },
            (response: any) => {
                if (chrome.runtime.lastError || !response?.ok) {
                    showToast(t('toast_site_toggle_failed'));
                    return;
                }

                setState((s) => ({
                    ...s,
                    mode: response.config?.mode || 'lite',
                    siteConfig: response.config || s.siteConfig,
                }));
                showToast(nextDisabled ? t('toast_site_paused') : t('toast_site_resumed'));
            },
        );
    };

    const handleRequestPermission = async () => {
        if (!state.domain) return;

        try {
            const origins = [`https://${state.domain}/*`, `http://${state.domain}/*`];
            const granted = await new Promise<boolean>((resolve, reject) => {
                chrome.permissions.request({ origins }, (result) => {
                    const err = chrome.runtime.lastError;
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve(Boolean(result));
                });
            });

            setState((s) => ({
                ...s,
                siteConfig: {
                    ...s.siteConfig,
                    hostPermissionGranted: granted,
                },
            }));

            chrome.runtime.sendMessage({ type: 'REQUEST_PERMISSIONS', domain: state.domain, granted });

            showToast(granted ? t('toast_permission_granted') : t('toast_permission_denied'));
        } catch {
            showToast(t('toast_permission_failed'));
        }
    };

    const handleReportBreakage = () => {
        chrome.runtime.sendMessage({ type: 'REPORT_ISSUE', domain: state.domain, details: 'site-breakage' }, (response: any) => {
            if (chrome.runtime.lastError || !response?.ok) {
                showToast(t('toast_issue_failed'));
                return;
            }

            if (response.autoSafeMode) {
                setState((s) => ({
                    ...s,
                    mode: 'lite',
                    siteConfig: {
                        ...s.siteConfig,
                        safeModeUntil: response.safeModeUntil,
                        mode: 'lite',
                        mainWorldOff: true,
                        cosmeticsOff: true,
                        siteFixesOff: true,
                    },
                }));
                showToast(t('toast_safe_mode'));
                return;
            }

            showToast(t('toast_issue_recorded'));
        });
    };

    const statsDisplay = useMemo(() => {
        return state.domainNeutralized.weighted.toLocaleString();
    }, [state.domainNeutralized.weighted]);

    const now = Date.now();
    const safeModeActive = Boolean(state.siteConfig.safeModeUntil && state.siteConfig.safeModeUntil > now);
    const isPaused = Boolean(state.siteConfig.disabled);
    const statusLabel = safeModeActive
        ? t('status_safe_mode')
        : isPaused
            ? t('status_paused')
            : state.mode === 'lite'
                ? t('status_lite')
                : t('status_active');

    if (state.isSystemPage) {
        return (
            <div className="popup-shell system-page">
                <header className="popup-header">
                    <div className="brand">
                        <span className="brand-mark"></span>
                        <span className="brand-title">{t('brand_short')}</span>
                    </div>
                </header>
                <main className="popup-body">
                    <div className="system-card">
                        <h2>{t('system_page_title')}</h2>
                        <p>{t('system_page_message')}</p>
                    </div>
                </main>
            </div>
        );
    }

    return (
        <div className="popup-shell">
            <header className="popup-header">
                <div className="brand">
                    <span className="brand-mark"></span>
                    <span className="brand-title">{t('brand_short')}</span>
                </div>
                <div className={`status-pill ${safeModeActive ? 'warn' : isPaused ? 'muted' : 'success'}`}>
                    <span className="dot"></span>
                    <span className="status-label">{statusLabel}</span>
                </div>
            </header>

            <main className="popup-body">
                <section className="stat-card">
                    <div className="stat-label">{t('label_neutralized')}</div>
                    <div className="stat-value">{statsDisplay}</div>
                </section>

                <section className="site-card">
                    <div className="site-meta">
                        <div className="site-label">{t('label_site')}</div>
                        <div className="site-domain">{state.domain}</div>
                    </div>
                    <div className="site-controls">
                        <button className="action-btn ghost" onClick={handleSiteDisableToggle}>
                            {isPaused ? <IconPlay /> : <IconPause />}
                            {isPaused ? t('action_resume') : t('action_pause')}
                        </button>
                        {!state.siteConfig.hostPermissionGranted && (
                            <button className="action-btn" onClick={handleRequestPermission}>
                                <IconKey />
                                {t('action_grant_permission')}
                            </button>
                        )}
                    </div>
                    {!state.siteConfig.hostPermissionGranted && (
                        <p className="hint">{t('help_permission')}</p>
                    )}
                    {safeModeActive && <p className="hint">{t('help_safe_mode')}</p>}
                </section>

                <section className="mode-card">
                    <div className="section-header">
                        <span>{t('label_mode')}</span>
                    </div>
                    <div className="mode-switch" role="tablist" aria-label={t('label_mode')}>
                        {(['lite', 'standard', 'advanced'] as FilteringMode[]).map((m) => (
                            <button
                                key={m}
                                className={`mode-btn ${state.mode === m ? 'active' : ''}`}
                                onClick={() => handleModeChange(m)}
                                disabled={state.siteConfig.disabled}
                                role="tab"
                                aria-selected={state.mode === m}
                            >
                                {tMode(m)}
                            </button>
                        ))}
                    </div>
                </section>

                {state.mode !== 'lite' && (
                    <section className="toggle-card">
                        <div className="section-header">
                            <span>{t('label_settings')}</span>
                        </div>
                        <ToggleRow
                            label={t('toggle_cosmetic')}
                            active={!state.siteConfig.cosmeticsOff}
                            onClick={() => handleToggle('cosmeticsOff')}
                        />
                        <ToggleRow
                            label={t('toggle_script')}
                            active={!state.siteConfig.siteFixesOff}
                            onClick={() => handleToggle('siteFixesOff')}
                        />
                    </section>
                )}

                <section className="actions-card">
                    <div className="section-header">
                        <span>{t('label_quick_actions')}</span>
                    </div>
                    <div className="actions-grid">
                        <button className="action-btn" onClick={handleReportBreakage}>
                            <IconAlert />
                            {t('action_report_issue')}
                        </button>
                        <button className="action-btn ghost" onClick={() => chrome.runtime.openOptionsPage()}>
                            <IconSettings />
                            {t('action_open_dashboard')}
                        </button>
                    </div>
                </section>
            </main>

            {state.toast && <div className="toast">{state.toast}</div>}
        </div>
    );
};

const ToggleRow: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({
    label,
    active,
    onClick,
}) => (
    <button
        className={`toggle-row ${active ? 'active' : ''}`}
        onClick={onClick}
        role="switch"
        aria-checked={active}
    >
        <span className="toggle-label">{label}</span>
        <span className="toggle-indicator"></span>
    </button>
);

const IconPause = () => (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
        <rect x="4" y="4" width="4" height="12" rx="1.5"></rect>
        <rect x="12" y="4" width="4" height="12" rx="1.5"></rect>
    </svg>
);

const IconPlay = () => (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M6 4.5L15 10l-9 5.5z"></path>
    </svg>
);

const IconKey = () => (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M6 11a4 4 0 1 1 3.6 2.2L8 15H6v-2H4v-2z"></path>
    </svg>
);

const IconAlert = () => (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 3l7 14H3L10 3z"></path>
        <path d="M10 7v5" strokeWidth="1.8" strokeLinecap="round" fill="none"></path>
        <circle cx="10" cy="14.5" r="1"></circle>
    </svg>
);

const IconSettings = () => (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z"></path>
        <path d="M16.2 9.3l1.3.7-1 1.8-1.4-.2a6.6 6.6 0 0 1-1 1.7l.6 1.3-1.8 1-1-.9a6.8 6.8 0 0 1-2 .3l-.6 1.3-2-.7.2-1.5a6.4 6.4 0 0 1-1.7-1l-1.4.5-1-1.8 1.1-1a6.6 6.6 0 0 1 0-2.1l-1.1-1 1-1.8 1.4.5a6.4 6.4 0 0 1 1.7-1l-.2-1.5 2-.7.6 1.3a6.8 6.8 0 0 1 2 .3l1-.9 1.8 1-.6 1.3a6.6 6.6 0 0 1 1 1.7l1.4-.2 1 1.8-1.3.7a6.6 6.6 0 0 1 0 1.4z"></path>
    </svg>
);

export default Popup;
