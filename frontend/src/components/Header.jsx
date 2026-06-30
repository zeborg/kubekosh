import { useState, useEffect } from 'react'
import styles from './Header.module.css'

// ── Inline Reload Cache Modal ─────────────────────────────────────────────────
function ReloadModal({ state, data, error, onClose, onReload }) {
  return (
    <div className={styles.modalOverlay} onClick={e => e.target === e.currentTarget && state !== 'loading' && onClose()}>
      <div className={styles.reloadModal}>
        {state === 'loading' && (
          <>
            <div className={styles.reloadModalIcon}>
              <span className={styles.reloadSpinner} />
            </div>
            <div className={styles.reloadModalTitle}>Reloading Cache…</div>
            <div className={styles.reloadModalSub}>Fetching latest scenarios, bundles, and addons from disk.</div>
          </>
        )}

        {state === 'success' && (
          <>
            <div className={`${styles.reloadModalIcon} ${styles.reloadIconSuccess}`}>✓</div>
            <div className={styles.reloadModalTitle}>Cache Reloaded</div>
            <div className={styles.reloadModalSub}>{data?.message}</div>
            <div className={styles.reloadStats}>
              <div className={styles.reloadStat}>
                <span className={styles.reloadStatNum}>{data?.scenarios_count ?? '—'}</span>
                <span className={styles.reloadStatLabel}>Scenarios</span>
              </div>
              <div className={styles.reloadStatDivider} />
              <div className={styles.reloadStat}>
                <span className={styles.reloadStatNum}>{data?.bundles_count ?? '—'}</span>
                <span className={styles.reloadStatLabel}>Bundles</span>
              </div>
              <div className={styles.reloadStatDivider} />
              <div className={styles.reloadStat}>
                <span className={styles.reloadStatNum}>{data?.addons_count ?? '—'}</span>
                <span className={styles.reloadStatLabel}>Addons</span>
              </div>
            </div>
            <div className={styles.reloadModalActions}>
              <button className={styles.reloadPageBtn} onClick={onReload}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6, verticalAlign: 'middle' }}>
                  <path d="M23 4v6h-6" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
                Reload Page
              </button>
              <button className={styles.reloadCloseBtn} onClick={onClose}>Close</button>
            </div>
          </>
        )}

        {state === 'error' && (
          <>
            <div className={`${styles.reloadModalIcon} ${styles.reloadIconError}`}>✕</div>
            <div className={styles.reloadModalTitle}>Reload Failed</div>
            <div className={styles.reloadModalError}>{error}</div>
            <div className={styles.reloadModalActions}>
              <button className={styles.reloadCloseBtn} onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Header ────────────────────────────────────────────────────────────────────
export default function Header({ clusterReady, onShowHistory, onShowAddons, addons = [] }) {
  const [theme, setTheme] = useState(
    () => localStorage.getItem('kubekosh-theme') || 'dark'
  )
  const [reloadModal, setReloadModal] = useState(null) // null | { state, data, error }

  // Dashboard shortcut config — id is the addon that provides the UI
  const DASHBOARD_CONFIG = [
    { id: 'kube-prometheus-stack', path: '/grafana', label: 'Open Grafana' },
    { id: 'opencost', path: '/opencost', label: 'Open OpenCost' },
    { id: 'traefik', path: '/traefik', label: 'Open Traefik' },
  ]

  // Only show buttons for installed addons; carry logo + icon from live data
  const dashboardBtns = DASHBOARD_CONFIG.flatMap(cfg => {
    const addon = addons.find(a => a.id === cfg.id)
    if (!addon || addon.status !== 'installed') return []
    return [{ ...cfg, logoUrl: addon.logo_url || null, icon: addon.icon || '📦' }]
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('kubekosh-theme', theme)
  }, [theme])

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark')

  const handleReloadCache = async () => {
    setReloadModal({ state: 'loading', data: null, error: null })
    try {
      const response = await fetch('/api/cache/reload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (response.ok) {
        const data = await response.json()
        setReloadModal({ state: 'success', data, error: null })
      } else {
        const data = await response.json().catch(() => ({}))
        setReloadModal({ state: 'error', data: null, error: data.error || 'Unknown error' })
      }
    } catch (err) {
      setReloadModal({ state: 'error', data: null, error: `Network error: ${err.message}` })
    }
  }

  return (
    <>
      <header className={styles.header}>
        <div className={styles.brand}>
          <div className={styles.logo}>
            <img src="/logo.svg" alt="KubeKosh Logo" className={styles.logoImage} />
            <span className={styles.logoText}>KubeKosh</span>
            <span className={styles.version}>{import.meta.env.VITE_APP_VERSION}</span>
          </div>
          <span className={styles.tagline}>Interactive Kubernetes Playground</span>
        </div>

        <div className={styles.right}>
          {/* GitHub link */}
          <div className={styles.githubBtnContainer}>
            <a
              href="https://github.com/zeborg/kubekosh"
              target="_blank"
              rel="noopener noreferrer"
              className={styles.githubBtn}
              aria-label="GitHub Repository"
            >
              <svg viewBox="0 0 512 512" width="16" height="16" fill="currentColor">
                <path d="M256 6.3C114.6 6.3 0 120.9 0 262.3c0 113.3 73.3 209 175 242.9 12.8 2.2 17.6-5.4 17.6-12.2 0-6.1-.3-26.2-.3-47.7-64.3 11.8-81-15.7-86.1-30.1-2.9-7.4-15.4-30.1-26.2-36.2-9-4.8-21.8-16.6-.3-17 20.2-.3 34.6 18.6 39.4 26.2 23 38.7 59.8 27.8 74.6 21.1 2.2-16.6 9-27.8 16.3-34.2-57-6.4-116.5-28.5-116.5-126.4 0-27.8 9.9-50.9 26.2-68.8-2.6-6.4-11.5-32.6 2.6-67.8 0 0 21.4-6.7 70.4 26.2 20.5-5.8 42.2-8.6 64-8.6s43.5 2.9 64 8.6c49-33.3 70.4-26.2 70.4-26.2 14.1 35.2 5.1 61.4 2.6 67.8 16.3 17.9 26.2 40.6 26.2 68.8 0 98.2-59.8 120-116.8 126.4 9.3 8 17.3 23.4 17.3 47.4 0 34.2-.3 61.8-.3 70.4 0 6.7 4.8 14.7 17.6 12.2C438.7 471.3 512 375.3 512 262.3c0-141.4-114.6-256-256-256" fillRule="evenodd" clipRule="evenodd" />
              </svg>
            </a>
          </div>

          {/* Theme toggle */}
          <div
            className={styles.themeBtnContainer}
            data-tooltip={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          >
            <button
              className={styles.themeBtn}
              onClick={toggleTheme}
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
          </div>

          {/* Cluster status */}
          <div className={`${styles.clusterBadge} ${clusterReady ? styles.ready : styles.notReady}`}>
            <span className={styles.dot} />
            <span>{clusterReady ? 'Cluster Ready' : 'Connecting…'}</span>
          </div>

          {/* Exam history */}
          <div className={styles.historyBtnContainer}>
            <button
              className={styles.historyBtn}
              onClick={onShowHistory}
              aria-label="View exam history"
              id="exam-history-btn"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
            </button>
          </div>

          {/* Addons */}
          <div className={styles.addonsBtnContainer}>
            <button
              className={styles.addonsBtn}
              onClick={onShowAddons}
              aria-label="Manage addons"
              id="addons-btn"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z" />
              </svg>
            </button>
          </div>

          {/* Dashboard shortcut buttons (only shown when addon is installed) */}
          {dashboardBtns.map(btn => (
            <div
              key={btn.id}
              className={styles.dashBtnContainer}
              data-tooltip={btn.label}
            >
              <a
                href={btn.path}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.dashBtn}
                aria-label={btn.label}
                id={`dashboard-btn-${btn.id}`}
              >
                {btn.logoUrl
                  ? <img src={btn.logoUrl} alt="" className={styles.dashBtnLogo} />
                  : <span className={styles.dashBtnEmoji}>{btn.icon}</span>
                }
              </a>
            </div>
          ))}


          {/* Reload cache */}
          <div className={styles.reloadBtnContainer}>
            <button
              className={`${styles.reloadBtn} ${reloadModal?.state === 'loading' ? styles.reloadBtnSpinning : ''}`}
              onClick={handleReloadCache}
              disabled={reloadModal?.state === 'loading'}
              aria-label="Reload scenario cache"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 4v6h-6" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* Reload cache modal */}
      {reloadModal && (
        <ReloadModal
          state={reloadModal.state}
          data={reloadModal.data}
          error={reloadModal.error}
          onClose={() => setReloadModal(null)}
          onReload={() => window.location.reload()}
        />
      )}
    </>
  )
}
