
import React, { useEffect, useState } from 'react';
import { StorageSchema, SiteSettings, DEFAULT_SITE_SETTINGS, SCHEMA_VERSION } from '@mugenblock/shared';

const RULESETS = [
    { id: 'ruleset_core', name: 'Core Ad-Blocker', desc: 'Essential rules for blocking common ads and trackers.' },
    { id: 'ruleset_privacy', name: 'Privacy Protection', desc: 'Blocks tracking pixels, fingerprinting scripts, and analytics beacons.' },
    { id: 'ruleset_peterlowe', name: 'Peter Lowe\'s List', desc: 'Community-maintained blocklist of known ad and tracking domains.' },
];

const Options: React.FC = () => {
    const [settings, setSettings] = useState<StorageSchema['settings'] | null>(null);
    const [perSite, setPerSite] = useState<Record<string, SiteSettings>>({});
    const [toast, setToast] = useState('');

    useEffect(() => {
        chrome.storage.local.get(['settings', 'perSite'], (data) => {
            setSettings(data.settings || null);
            setPerSite(data.perSite || {});
        });
    }, []);

    const showToast = (msg: string) => {
        setToast(msg);
        setTimeout(() => setToast(''), 2500);
    };

    const toggleRuleset = (id: string) => {
        if (!settings) return;
        const newRulesets = settings.enabledRulesets.includes(id)
            ? settings.enabledRulesets.filter(r => r !== id)
            : [...settings.enabledRulesets, id];
        const newSettings = { ...settings, enabledRulesets: newRulesets };
        setSettings(newSettings);
        chrome.storage.local.set({ settings: newSettings });
        showToast('Rulesets updated');
    };

    const removeSiteOverride = (domain: string) => {
        const updated = { ...perSite };
        delete updated[domain];
        setPerSite(updated);
        chrome.storage.local.set({ perSite: updated });
        showToast(`Removed override for ${domain}`);
    };

    const clearAllOverrides = () => {
        setPerSite({});
        chrome.runtime.sendMessage({ type: 'CLEAR_SITE_OVERRIDES' });
        showToast('All site overrides cleared');
    };

    const exportSettings = () => {
        chrome.runtime.sendMessage({ type: 'EXPORT_SETTINGS' }, (res) => {
            if (res?.ok) {
                const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `mugenblock-settings-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
                showToast('Settings exported');
            }
        });
    };

    const importSettings = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                chrome.runtime.sendMessage({ type: 'IMPORT_SETTINGS', data }, (res) => {
                    if (res?.ok) {
                        showToast('Settings imported — reload extension to apply');
                        // Refresh local state
                        chrome.storage.local.get(['settings', 'perSite'], (d) => {
                            setSettings(d.settings);
                            setPerSite(d.perSite || {});
                        });
                    }
                });
            } catch {
                showToast('Invalid file format');
            }
        };
        input.click();
    };

    const exportBreakageReport = () => {
        const report = {
            version: chrome.runtime.getManifest().version,
            schemaVersion: SCHEMA_VERSION,
            globalMode: settings?.mode || 'lite',
            enabledRulesets: settings?.enabledRulesets || [],
            siteOverrideCount: Object.keys(perSite).length,
            // Privacy: only include domain names, no full URLs
            overriddenDomains: Object.keys(perSite),
            timestamp: new Date().toISOString(),
        };
        navigator.clipboard.writeText(JSON.stringify(report, null, 2));
        showToast('Breakage report copied to clipboard');
    };

    if (!settings) {
        return <div className="options-container"><p className="loading">Loading...</p></div>;
    }

    const siteEntries = Object.entries(perSite).filter(([, v]) =>
        v.mode !== DEFAULT_SITE_SETTINGS.mode || v.breakageCount > 0 || v.cosmeticsOff || v.mainWorldOff || v.siteFixesOff
    );

    return (
        <div className="options-container">
            <header className="header-main">
                <div className="title-group">
                    <div className="logo-wrapper">
                        <img src="/icons/icon128.png" className="logo" alt="" />
                    </div>
                    <div className="title-meta">
                        <h1>Advanced Dashboard</h1>
                        <span className="version">MugenBlock Engine v{chrome.runtime.getManifest().version}</span>
                    </div>
                </div>
                <div className="header-actions">
                    <a href="https://github.com/mugenyume" target="_blank" rel="noopener noreferrer" className="github-link-icon" title="View Source on GitHub">
                        <svg viewBox="0 0 24 24" width="24" height="24">
                            <path fill="currentColor" d="M12,2A10,10 0 0,0 2,12C2,16.42 4.87,20.17 8.84,21.5C9.34,21.58 9.5,21.27 9.5,21.03C9.5,20.82 9.5,20.24 9.5,19.41C6.72,20.01 6.13,18.06 6.13,18.06C5.68,16.91 5.03,16.61 5.03,16.61C4.12,15.99 5.1,16 5.1,16C6.1,16.07 6.63,17.03 6.63,17.03C7.5,18.54 8.95,18.11 9.5,17.88C9.6,17.25 9.85,16.82 10.12,16.59C7.9,16.34 5.56,15.48 5.56,11.65C5.56,10.55 5.96,9.65 6.59,8.94C6.49,8.69 6.14,7.66 6.69,6.27C6.69,6.27 7.54,6 9.47,7.3C10.28,7.07 11.14,6.96 12,6.96C12.86,6.96 13.72,7.07 14.53,7.3C16.46,6 17.3,6.27 17.3,6.27C17.86,7.66 17.51,8.69 17.41,8.94C18.04,9.65 18.44,10.55 18.44,11.65C18.44,15.49 16.1,16.34 13.87,16.59C14.23,16.9 14.55,17.5 14.55,18.44C14.55,19.79 14.54,20.87 14.54,21.2C14.54,21.46 14.7,21.77 15.21,21.67C19.16,20.33 22,16.58 22,12A10,10 0 0,0 12,2Z" />
                        </svg>
                    </a>
                    <button className="btn btn-secondary small" onClick={exportBreakageReport}>
                        📋 Copy Report
                    </button>
                </div>
            </header>

            <main className="main-content">
                {/* ── Filter Rulesets ─────────────────────────────────────── */}
                <section className="glass-card">
                    <div className="card-header">
                        <h2>Filter Rulesets</h2>
                        <span className="info-badge">CORE SHIELDS</span>
                    </div>
                    <div className="ruleset-grid">
                        {RULESETS.map(rs => (
                            <div className={`ruleset-card ${settings.enabledRulesets.includes(rs.id) ? 'active' : ''}`} key={rs.id} onClick={() => toggleRuleset(rs.id)}>
                                <div className="ruleset-info">
                                    <div className="ruleset-header">
                                        <div className="custom-checkbox">
                                            <div className={`checkbox-inner ${settings.enabledRulesets.includes(rs.id) ? 'checked' : ''}`} />
                                        </div>
                                        <h3>{rs.name}</h3>
                                    </div>
                                    <p className="desc">{rs.desc}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>

                {/* ── Per-Site Overrides ──────────────────────────────────── */}
                <section className="glass-card">
                    <div className="card-header">
                        <h2>Site Overrides</h2>
                        {siteEntries.length > 0 && (
                            <button className="link-btn danger" onClick={clearAllOverrides}>Reset All</button>
                        )}
                    </div>
                    {siteEntries.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-icon">🛡</div>
                            <p>No active site overrides. Adjust protection levels via the popup while browsing.</p>
                        </div>
                    ) : (
                        <div className="sites-list">
                            {siteEntries.map(([domain, config]) => (
                                <div className="site-row" key={domain}>
                                    <div className="site-main">
                                        <span className="site-icon">🌐</span>
                                        <div className="site-details">
                                            <div className="site-domain">{domain}</div>
                                            <div className="site-tags">
                                                {config.cosmeticsOff && <span className="tag-pill error">Cosmetics Off</span>}
                                                {config.mainWorldOff && <span className="tag-pill error">Shield Off</span>}
                                                {config.siteFixesOff && <span className="tag-pill error">Fixes Off</span>}
                                                {config.breakageCount >= 2 && <span className="tag-pill warn">Auto-Relaxed</span>}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="site-actions">
                                        <div className={`site-mode-pill mode-${config.mode}`}>{config.mode}</div>
                                        <button className="icon-btn remove" onClick={() => removeSiteOverride(domain)} title="Delete Override">
                                            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19V4M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z" /></svg>
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </section>

                <div className="two-col-grid">
                    {/* ── Privacy ─────────────────────────────────────── */}
                    <section className="glass-card">
                        <div className="card-header">
                            <h2>Privacy Settings</h2>
                        </div>
                        <div className="tile-toggle-row" onClick={() => {
                            const updated = { ...settings, allowRemoteConfig: !settings.allowRemoteConfig };
                            setSettings(updated);
                            chrome.storage.local.set({ settings: updated });
                        }}>
                            <div className="toggle-meta">
                                <h3>Remote Filter Updates</h3>
                                <p>Allow background synchronization of data-only rule updates for zero-day protection.</p>
                            </div>
                            <div className={`ios-switch ${settings.allowRemoteConfig ? 'on' : 'off'}`}>
                                <div className="switch-handle" />
                            </div>
                        </div>
                        <div className="privacy-infobox">
                            <span className="info-icon">🔒</span>
                            <p>
                                <strong>Privacy First:</strong> All browsing data remains strictly local.
                                MugenBlock never collects telemetry, analytics, or personal info.
                            </p>
                        </div>
                    </section>

                    {/* ── Backup & Restore ─────────────────────────────────────── */}
                    <section className="glass-card">
                        <div className="card-header">
                            <h2>Cloud Sync & Backup</h2>
                        </div>
                        <p className="section-intro">Synchronize your configuration or migrate to another device.</p>
                        <div className="backup-actions">
                            <button className="btn btn-primary fluid" onClick={exportSettings}>
                                📥 Backup Settings
                            </button>
                            <button className="btn btn-secondary fluid" onClick={importSettings}>
                                📤 Restore from File
                            </button>
                        </div>
                    </section>
                </div>
            </main>

            {toast && <div className="glass-toast">{toast}</div>}
        </div>
    );
};

export default Options;
