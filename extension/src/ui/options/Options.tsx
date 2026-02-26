import React, { useEffect, useState, useMemo } from 'react';
import { StorageSchema, SiteSettings, DEFAULT_SITE_SETTINGS, SCHEMA_VERSION } from '@mugenblock/shared';

const RULESETS = [
    { id: 'ruleset_core', name: 'Core Engine', desc: 'Neural-pathway ad blocking for the modern web.' },
    { id: 'ruleset_privacy', name: 'Privacy Matrix', desc: 'Neutralize trackers and telemetry beacons.' },
    { id: 'ruleset_peterlowe', name: 'Community Guard', desc: 'Crowdsourced intelligence for zero-day protection.' },
];

const Options: React.FC = () => {
    const [settings, setSettings] = useState<StorageSchema['settings'] | null>(null);
    const [perSite, setPerSite] = useState<Record<string, SiteSettings>>({});
    const [stats, setStats] = useState<StorageSchema['stats'] | null>(null);
    const [toast, setToast] = useState('');

    useEffect(() => {
        const load = async () => {
            const data = await chrome.storage.local.get(['settings', 'perSite', 'stats']);
            setSettings(data.settings || null);
            setPerSite(data.perSite || {});
            setStats(data.stats || null);
        };
        load();

        // Reactive updates from background
        const listener = (changes: any, area: string) => {
            if (area !== 'local') return;
            if (changes.settings) setSettings(changes.settings.newValue);
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

    const updateSettings = async (newSettings: any) => {
        setSettings(newSettings);
        return chrome.runtime.sendMessage({ type: 'IMPORT_SETTINGS', data: { settings: newSettings } });
    };

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
        showToast('Local site intelligence reset.');
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
                showToast('Configuration exported.');
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
                                showToast('Configuration restored.');
                            } else {
                                showToast('Import failed: Invalid format.');
                            }
                        });
                    } else {
                        showToast('Import failed: Missing core parameters.');
                    }
                } catch (err) {
                    showToast('Import failed: Data corruption.');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    };

    if (!settings) return <div className="loading-screen">INITIALIZING MUGEN_CORE...</div>;

    const siteEntries = Object.entries(perSite).filter(([, v]) => v.mode !== 'lite' || v.breakageCount > 0);

    return (
        <div className="command-center">
            <header className="cc-header">
                <div className="branding">
                    <span className="logo-pulse"></span>
                    <h1>MUGEN COMMAND</h1>
                </div>
                <div className="system-stats">
                    <div className="stat-node">
                        <span className="label">ACTIVE_FILTERS</span>
                        <span className="value">{settings.enabledRulesets.length}</span>
                    </div>
                    <div className="stat-node">
                        <span className="label">THREATS_STOPPED</span>
                        <span className="value">{stats?.totalBlocked.toLocaleString()}</span>
                    </div>
                </div>
            </header>

            <main className="cc-grid">
                <section className="cc-card filters">
                    <div className="card-label">SUBSYSTEMS</div>
                    <div className="ruleset-list">
                        {RULESETS.map((rs) => (
                            <div
                                key={rs.id}
                                className={`ruleset-node ${settings.enabledRulesets.includes(rs.id) ? 'active' : ''}`}
                                onClick={() => toggleRuleset(rs.id)}
                            >
                                <div className="node-info">
                                    <h3>{rs.name}</h3>
                                    <p>{rs.desc}</p>
                                </div>
                                <div className="node-status">
                                    {settings.enabledRulesets.includes(rs.id) ? 'OPERATIONAL' : 'OFFLINE'}
                                </div>
                            </div>
                        ))}
                    </div>
                </section>

                <section className="cc-card site-intelligence">
                    <div className="card-label">SITE_SPECIFIC_INTELLIGENCE</div>
                    {siteEntries.length === 0 ? (
                        <div className="empty-intelligence">
                            No overrides detected. Extension is running in global {settings.mode} mode.
                        </div>
                    ) : (
                        <div className="intelligence-list">
                            {siteEntries.map(([domain, config]) => (
                                <div key={domain} className="intelligence-node">
                                    <span className="domain">{domain}</span>
                                    <div className="tags">
                                        <span className={`mode-tag ${config.mode}`}>{config.mode.toUpperCase()}</span>
                                        {config.breakageCount > 0 && (
                                            <span className="error-tag">BREAKAGE_REPORTED</span>
                                        )}
                                    </div>
                                </div>
                            ))}
                            <button className="reset-trigger" onClick={clearOverrides}>
                                PURGE_LOCAL_DATA
                            </button>
                        </div>
                    )}
                </section>

                <section className="cc-card connectivity">
                    <div className="card-label">GLOBAL_PARAMETERS</div>
                    <div className="toggle-row">
                        <div className="info">
                            <h3>Real-time Matrix Sync</h3>
                            <p>Enable encrypted synchronization with the global threat database.</p>
                        </div>
                        <MinimalSwitch
                            active={settings.allowRemoteConfig}
                            onClick={() =>
                                updateSettings({ ...settings, allowRemoteConfig: !settings.allowRemoteConfig })
                            }
                        />
                    </div>

                    <div className="action-footer">
                        <button className="cc-btn primary" onClick={exportConfig}>
                            BACKUP_CORE
                        </button>
                        <button className="cc-btn primary" onClick={importConfig}>
                            RESTORE_CORE
                        </button>
                        <button className="cc-btn secondary" onClick={() => chrome.runtime.openOptionsPage()}>
                            REFRESH_INTERFACE
                        </button>
                    </div>
                </section>
            </main>

            {toast && <div className="cc-toast">{toast}</div>}
        </div>
    );
};

const MinimalSwitch: React.FC<{ active: boolean; onClick: () => void }> = ({ active, onClick }) => (
    <div
        className={`cc-switch ${active ? 'active' : ''}`}
        onClick={onClick}
        role="switch"
        aria-checked={active}
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClick()}
    >
        <div className="switch-thumb"></div>
    </div>
);

export default Options;
