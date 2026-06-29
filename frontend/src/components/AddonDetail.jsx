import { useState, useCallback } from 'react'
import styles from './AddonsView.module.css'
import { useAddonDetail } from './useAddons'
import { useAddonStream } from './useAddonStream'
import { statusMeta, targetLabel } from './addonStatus'
import AddonLogPane from './AddonLogPane'
import AddonIcon from './AddonIcon'

const BUSY = new Set(['queued', 'installing', 'removing'])

// Detail panel for the selected addon: metadata, dependency chain, the resolved
// install plan (live during a run), action buttons, and a streaming log pane.
export default function AddonDetail({ id, onChanged }) {
  const { detail, refresh } = useAddonDetail(id)
  const [streaming, setStreaming] = useState(false)
  const [actionError, setActionError] = useState(null)

  const handleStatus = useCallback((s) => {
    // A status change for the selected addon means the catalog + detail are stale.
    if (s.addon === id) refresh()
    onChanged?.()
  }, [id, refresh, onChanged])

  // Keep the stream open while busy, and also while install_failed so the
  // background auto-promotion (health check passes → installed) shows up live.
  const watch = detail && (BUSY.has(detail.status) || detail.status === 'install_failed')
  const { logs, statuses, clear } = useAddonStream(id, streaming || watch, handleStatus)

  const act = useCallback(async (kind) => {
    setActionError(null)
    try {
      const res = await fetch(`/api/addons/${id}/${kind}`, { method: 'POST' })
      if (res.status === 202) {
        // Keep existing logs on cancel so the revert output appends in context.
        if (kind !== 'cancel') clear()
        setStreaming(true)
        refresh()
      } else {
        const body = await res.json().catch(() => ({}))
        const dep = body.dependents?.length ? ` (${body.dependents.join(', ')})` : ''
        setActionError((body.error || 'Action failed') + dep)
      }
    } catch (e) {
      setActionError(`Network error: ${e.message}`)
    }
  }, [id, refresh, clear])

  if (!id) {
    return (
      <div className={styles.detailEmpty}>
        <div className={styles.detailEmptyIcon}>🧩</div>
        <p>Select an addon to see details.</p>
      </div>
    )
  }
  if (!detail) {
    return <div className={styles.detailEmpty}><p>Loading…</p></div>
  }

  // Live status overrides the fetched snapshot during a run.
  const effStatus = statuses[id] || detail.status
  const meta = statusMeta(effStatus)
  const busy = BUSY.has(effStatus)
  const isInstalled = effStatus === 'installed'
  const updateAvailable = isInstalled && !!detail.installed_version && detail.installed_version !== detail.version
  // Show the Remove control for installed addons and for in-flight removals
  // (removing, or queued for removal); everything else gets the Install control.
  const showRemove = isInstalled || effStatus === 'removing'
    || (effStatus === 'queued' && detail.queued_action === 'remove')
  const plan = detail.install_plan || { order: [], to_install: 0 }
  const planError = plan.error

  return (
    <div className={styles.detail}>
      <div className={styles.detailHead}>
        <AddonIcon addon={detail} imgClassName={styles.detailLogo} iconClassName={styles.detailIcon} />
        <div className={styles.detailHeadText}>
          <div className={styles.detailName}>{detail.name}</div>
          <div className={styles.detailMetaRow}>
            <span className={`${styles.statusBadge} ${styles[`status${meta.tone}`]}`}>
              {meta.busy && <span className={styles.badgeSpinner} />}
              {meta.label}
            </span>
            <span className={`${styles.targetTag} ${detail.target === 'cluster' ? styles.targetCluster : styles.targetOs}`}>
              {targetLabel(detail.target)}
            </span>
            <span className={styles.detailVersion}>
              v{isInstalled ? (detail.installed_version || detail.version) : detail.version}
            </span>
            {updateAvailable && (
              <span className={styles.updateTag}>update available → v{detail.version}</span>
            )}
          </div>
        </div>
      </div>

      <p className={styles.detailDesc}>{detail.description}</p>

      {detail.docs_url && (
        <a className={styles.detailDocs} href={detail.docs_url} target="_blank" rel="noopener noreferrer">
          Documentation ↗
        </a>
      )}

      {actionError && <div className={styles.detailError}>{actionError}</div>}
      {!actionError && detail.last_error && effStatus.endsWith('failed') && (
        <div className={styles.detailError}>{detail.last_error}</div>
      )}

      {detail.dependencies.length > 0 && (
        <div className={styles.detailSection}>
          <div className={styles.detailSectionTitle}>Dependencies</div>
          <div className={styles.chips}>
            {detail.dependencies.map(d => <span key={d} className={styles.chip}>{d}</span>)}
          </div>
        </div>
      )}

      {/* Install plan — rows pick up live status during a run */}
      {(!isInstalled || updateAvailable) && plan.order.length > 0 && (
        <div className={styles.detailSection}>
          <div className={styles.detailSectionTitle}>Install plan</div>
          {planError ? (
            <div className={styles.detailError}>{planError}</div>
          ) : (
            <ol className={styles.planList}>
              {plan.order.map((step, i) => {
                const live = statuses[step.id]
                return (
                  <li key={step.id} className={styles.planStep}>
                    <span className={styles.planNum}>{i + 1}</span>
                    <span className={styles.planStepName}>{step.name}</span>
                    <span className={planRowClass(live, step.action, styles)}>
                      {planRowLabel(live, step.action)}
                    </span>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      )}

      {/* Actions */}
      <div className={styles.detailActions}>
        {isInstalled && updateAvailable && (
          <button className={styles.installBtn} disabled={busy} onClick={() => act('install')}>
            Update to v{detail.version}
          </button>
        )}
        {showRemove ? (
          <button className={styles.removeBtn} disabled={busy} onClick={() => act('remove')}>
            {effStatus === 'removing' ? 'Removing…'
              : effStatus === 'queued' ? 'Queued…' : 'Remove'}
          </button>
        ) : (effStatus === 'installing' || effStatus === 'queued') ? (
          <div className={styles.installRow}>
            <button className={styles.installBtn} disabled>
              {effStatus === 'installing' ? 'Installing…' : 'Queued…'}
            </button>
            <button
              className={styles.cancelIconBtn}
              onClick={() => act('cancel')}
              aria-label="Cancel installation"
              data-tooltip="Cancel installation"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        ) : (
          <button className={styles.installBtn} disabled={busy} onClick={() => act('install')}>
            {plan.to_install > 1 ? `Install all (${plan.to_install})` : 'Install'}
          </button>
        )}
      </div>

      {/* Live log */}
      {(busy || logs.length > 0) && (
        <div className={styles.detailSection}>
          <div className={styles.detailSectionTitle}>Output</div>
          <AddonLogPane logs={logs} />
        </div>
      )}
    </div>
  )
}

function planRowLabel(live, action) {
  if (live === 'installed') return '✓ installed'
  if (live === 'installing') return action === 'upgrade' ? 'upgrading…' : 'installing…'
  if (live === 'install_failed') return '✗ failed'
  // not started yet — show the planned action
  if (action === 'skip') return '✓ up to date'
  if (action === 'upgrade') return 'will upgrade'
  return 'will install'
}

function planRowClass(live, action, styles) {
  if (live === 'installed' || action === 'skip') return styles.planSkip
  if (live === 'install_failed') return styles.planFailed
  return styles.planInstall
}
