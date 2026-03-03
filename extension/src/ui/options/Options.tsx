import React, { useEffect, useMemo, useState } from 'react';
import { t, tMode } from '../i18n';
import { StorageSchema, SiteSettings } from '@mugenblock/shared';

const DEFAULT_SETTINGS: StorageSchema['settings'] = {
    mode: 'lite',
    enabledRulesets: ['ruleset_core', 'ruleset_easylist', 'ruleset_privacy', 'ruleset_easyprivacy', 'ruleset_peterlowe'],
    allowRemoteConfig: false,
    metricsEnabled: false,
};

const Options: React.FC = () => {
    const [settings, setSettings] = useState<StorageSchema['settings'] | null>(null);
    const [perSite, setPerSite] = useState<Record<string, SiteSettings>>({});
    const [stats, setStats] = useState<StorageSchema['stats'] | null>(null);
    const [toast, setToast] = useState('');

    useEffect(() => {
        const load = async () => {
            const data = await chrome.storage.local.get(['settings', 'perSite', 'stats']);
            setSettings({ ...DEFAULT_SETTINGS, ...(data.settings || {}) });
            setPerSite(data.perSite || {});
            setStats(data.stats || null);
        };
        load();

        const listener = (changes: any, area: string) => {
            if (area !== 'local') return;
            if (changes.settings) setSettings({ ...DEFAULT_SETTINGS, ...changes.settings.newValue });
            if (changes.perSite) setPerSite(changes.perSite.newValue);
            if (changes.stats) setStats(changes.stats.newValue);
        };
        chrome.storage.onChanged.addListener(listener);
        return () => chrome.storage.onChanged.removeListener(listener);
    }, []);

    const showToast = (msg: string) => {
        setToast(msg);
        setTimeout(() => setToast(''), 3000);
    };

    const updateSettings = async (newSettings: StorageSchema['settings']) => {
        setSettings(newSettings);
        return chrome.runtime.sendMessage({ type: 'IMPORT_SETTINGS', data: { settings: newSettings } });
    };

    const rulesets = useMemo(
        () => [
            {
                id: 'ruleset_core',
                name: t('ruleset_core_name'),
                desc: t('ruleset_core_desc'),
            },
            {
                id: 'ruleset_easylist',
                name: t('ruleset_easylist_name'),
                desc: t('ruleset_easylist_desc'),
            },
            {
                id: 'ruleset_privacy',
                name: t('ruleset_privacy_name'),
                desc: t('ruleset_privacy_desc'),
            },
            {
                id: 'ruleset_easyprivacy',
                name: t('ruleset_easyprivacy_name'),
                desc: t('ruleset_easyprivacy_desc'),
            },
            {
                id: 'ruleset_peterlowe',
                name: t('ruleset_peterlowe_name'),
                desc: t('ruleset_peterlowe_desc'),
            },
        ],
        [],
    );

    const toggleRuleset = async (id: string) => {
        if (!settings) return;
        const isEnabled = settings.enabledRulesets.includes(id);
        const newRulesets = isEnabled
            ? settings.enabledRulesets.filter((r) => r !== id)
            : [...settings.enabledRulesets, id];

        await updateSettings({ ...settings, enabledRulesets: newRulesets });
        chrome.runtime.sendMessage({ type: 'RELOAD_RULES' });
    };

    const clearOverrides = () => {
        setPerSite({});
        chrome.runtime.sendMessage({ type: 'CLEAR_SITE_OVERRIDES' });
        showToast(t('toast_overrides_cleared'));
    };

    const exportConfig = () => {
        chrome.runtime.sendMessage({ type: 'EXPORT_SETTINGS' }, (res) => {
            if (res?.ok) {
                const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `mugen-config-${new Date().toISOString().split('T')[0]}.json`;
                a.click();
                showToast(t('toast_exported'));
            }
        });
    };

    const importConfig = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e: any) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    const data = JSON.parse(event.target?.result as string);
                    if (data.settings && data.schemaVersion) {
                        chrome.runtime.sendMessage({ type: 'IMPORT_SETTINGS', data }, (res) => {
                            if (res?.ok) {
                                showToast(t('toast_restored'));
                            } else {
                                showToast(t('toast_import_invalid'));
                            }
                        });
                    } else {
                        showToast(t('toast_import_missing'));
                    }
                } catch {
                    showToast(t('toast_import_corrupt'));
                }
            };
            reader.readAsText(file);
        };
        input.click();
    };

    if (!settings) return <div className="loading-screen">{t('options_loading')}</div>;

    const siteEntries = Object.entries(perSite).filter(([, v]) => v.mode !== 'lite' || v.breakageCount > 0);

    return (
        <div className="options-shell">
            <header className="options-header">
                <div className="options-title">
                    <div className="brand-mark"></div>
                    <div>
                        <h1>{t('options_title')}</h1>
                        <p>{t('options_subtitle')}</p>
                    </div>
                </div>
                <div className="stats-row">
                    <div className="stat-chip">
                        <span>{t('options_stat_filters')}</span>
                        <strong>{settings.enabledRulesets.length}</strong>
                    </div>
                    <div className="stat-chip">
                        <span>{t('options_stat_blocked')}</span>
                        <strong>{stats?.totalBlocked.toLocaleString()}</strong>
                    </div>
                </div>
            </header>

            <main className="options-grid">
                <section className="panel">
                    <div className="panel-header">
                        <h2>{t('options_section_rulesets')}</h2>
                    </div>
                    <div className="panel-body">
                        <div className="ruleset-grid">
                            {rulesets.map((rs) => {
                                const active = settings.enabledRulesets.includes(rs.id);
                                return (
                                    <button
                                        key={rs.id}
                                        className={`ruleset-card ${active ? 'active' : ''}`}
                                        onClick={() => toggleRuleset(rs.id)}
                                    >
                                        <div className="ruleset-header">
                                            <h3>{rs.name}</h3>
                                            <span className={`badge ${active ? 'success' : 'muted'}`}>
                                                {active ? t('ruleset_status_on') : t('ruleset_status_off')}
                                            </span>
                                        </div>
                                        <p>{rs.desc}</p>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </section>

                <section className="panel">
                    <div className="panel-header">
                        <h2>{t('options_section_sites')}</h2>
                    </div>
                    <div className="panel-body">
                        {siteEntries.length === 0 ? (
                            <div className="empty-state">
                                {t('sites_empty', tMode(settings.mode))}
                            </div>
                        ) : (
                            <div className="site-list">
                                {siteEntries.map(([domain, config]) => (
                                    <div key={domain} className="site-row">
                                        <div>
                                            <div className="site-domain">{domain}</div>
                                            <div className="site-meta">
                                                <span className={`badge ${config.mode}`}>{tMode(config.mode)}</span>
                                                {config.breakageCount > 0 && (
                                                    <span className="badge danger">{t('sites_breakage')}</span>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                                <button className="action-btn ghost" onClick={clearOverrides}>
                                    {t('sites_reset')}
                                </button>
                            </div>
                        )}
                    </div>
                </section>

                <section className="panel">
                    <div className="panel-header">
                        <h2>{t('options_section_settings')}</h2>
                    </div>
                    <div className="panel-body">
                        <div className="setting-row">
                            <div>
                                <h3>{t('settings_remote_sync')}</h3>
                                <p>{t('settings_remote_sync_desc')}</p>
                            </div>
                            <MinimalSwitch
                                active={settings.allowRemoteConfig}
                                onClick={() => updateSettings({ ...settings, allowRemoteConfig: !settings.allowRemoteConfig })}
                            />
                        </div>

                        <div className="setting-row">
                            <div>
                                <h3>{t('settings_metrics')}</h3>
                                <p>{t('settings_metrics_desc')}</p>
                            </div>
                            <MinimalSwitch
                                active={settings.metricsEnabled}
                                onClick={() => updateSettings({ ...settings, metricsEnabled: !settings.metricsEnabled })}
                            />
                        </div>

                        <div className="action-row">
                            <button className="action-btn" onClick={exportConfig}>
                                {t('options_backup')}
                            </button>
                            <button className="action-btn" onClick={importConfig}>
                                {t('options_restore')}
                            </button>
                            <button className="action-btn ghost" onClick={() => chrome.runtime.openOptionsPage()}>
                                {t('options_refresh')}
                            </button>
                        </div>
                    </div>
                </section>

                <section className="panel">
                    <div className="panel-header">
                        <h2>Contacts</h2>
                    </div>
                    <div className="panel-body">
                        <div className="contact-grid">
                            <a
                                className="contact-link"
                                href="https://mugneyume.cv"
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                <span className="contact-icon" aria-hidden="true">
                                    <IconPortfolio />
                                </span>
                                <span>Portfolio</span>
                            </a>
                            <a
                                className="contact-link"
                                href="https://github.com/mugenyume"
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                <span className="contact-icon" aria-hidden="true">
                                    <IconGitHub />
                                </span>
                                <span>GitHub</span>
                            </a>
                            <a
                                className="contact-link"
                                href="https://x.com/mugenyume_x"
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                <span className="contact-icon" aria-hidden="true">
                                    <IconX />
                                </span>
                                <span>X</span>
                            </a>
                        </div>
                    </div>
                </section>
            </main>

            {toast && <div className="toast">{toast}</div>}
        </div>
    );
};

const MinimalSwitch: React.FC<{ active: boolean; onClick: () => void }> = ({ active, onClick }) => (
    <button
        className={`switch ${active ? 'active' : ''}`}
        onClick={onClick}
        role="switch"
        aria-checked={active}
    >
        <span className="switch-thumb"></span>
    </button>
);

const IconPortfolio = () => (
    <svg className="contact-svg" viewBox="0 0 20 20" aria-hidden="true">
        <rect x="3" y="5" width="14" height="11" rx="2"></rect>
        <path d="M7 5V3.8c0-.9.7-1.6 1.6-1.6h2.8c.9 0 1.6.7 1.6 1.6V5"></path>
        <path d="M3 9.2h14"></path>
    </svg>
);

const IconGitHub = () => (
    <svg className="contact-svg" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 2.2a7.8 7.8 0 0 0-2.5 15.2c.4.1.5-.2.5-.4v-1.5c-2 .4-2.5-.8-2.5-.8-.3-.8-.8-1-1-1.1-.8-.5.1-.5.1-.5.9.1 1.3.9 1.3.9.8 1.4 2.1 1 2.6.8.1-.6.3-1 .6-1.2-1.6-.2-3.3-.8-3.3-3.4 0-.7.2-1.3.7-1.8-.1-.2-.3-.9.1-1.8 0 0 .6-.2 1.9.7a6.4 6.4 0 0 1 3.4 0c1.3-.9 1.9-.7 1.9-.7.4.9.2 1.6.1 1.8.5.5.7 1.1.7 1.8 0 2.6-1.7 3.2-3.3 3.4.3.2.6.8.6 1.5V17c0 .2.1.5.5.4A7.8 7.8 0 0 0 10 2.2z"></path>
    </svg>
);

const IconX = () => (
    <svg className="contact-svg" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M3 3h3.6l3.7 5.3L14.7 3H17l-5.4 6.1L17 17h-3.6l-4-5.8L4.3 17H2l5.8-6.6L3 3z"></path>
    </svg>
);

export default Options;
