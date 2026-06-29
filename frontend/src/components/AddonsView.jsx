import { useState, useMemo, useEffect } from 'react'
import styles from './AddonsView.module.css'
import { useAddons } from './useAddons'
import { statusMeta } from './addonStatus'
import AddonCard from './AddonCard'
import AddonDetail from './AddonDetail'

const ALL = '__all__'

// Addons popup: catalog grid with filters on the left, detail panel on the
// right, inside a modal shell. Read-only in Phase 2.
export default function AddonsView({ onClose }) {
  const { addons, loading, error, refresh } = useAddons()
  const [selectedId, setSelectedId] = useState(null)
  const [category, setCategory] = useState(ALL)
  const [status, setStatus] = useState(ALL)
  const [target, setTarget] = useState(ALL)

  const categories = useMemo(
    () => [...new Set(addons.map(a => a.category))].sort(),
    [addons]
  )

  const filtered = useMemo(() => addons.filter(a =>
    (category === ALL || a.category === category) &&
    (status === ALL || a.status === status) &&
    (target === ALL || a.target === target)
  ), [addons, category, status, target])

  const pollMs = useMemo(() => (
    addons.some(a => ['queued', 'installing', 'removing', 'install_failed'].includes(a.status))
      ? 2500 : 15000
  ), [addons])

  useEffect(() => {
    const id = setInterval(refresh, pollMs)
    return () => clearInterval(id)
  }, [pollMs, refresh])

  return (
    <div className={styles.overlay} onClick={e => e.target === e.currentTarget && onClose?.()}>
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <span className={styles.modalTitleIcon}>🧩</span>
          <span className={styles.modalTitle}>Addons</span>
          <div className={styles.filters}>
            <select className={styles.select} value={category} onChange={e => setCategory(e.target.value)}>
              <option value={ALL}>All categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select className={styles.select} value={status} onChange={e => setStatus(e.target.value)}>
              <option value={ALL}>All statuses</option>
              {['available', 'installed', 'installing', 'install_failed'].map(s => (
                <option key={s} value={s}>{statusMeta(s).label}</option>
              ))}
            </select>
            <select className={styles.select} value={target} onChange={e => setTarget(e.target.value)}>
              <option value={ALL}>All targets</option>
              <option value="os">OS</option>
              <option value="cluster">Cluster</option>
            </select>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close addons">✕</button>
        </div>

        <div className={styles.split}>
          <div className={styles.catalog}>
            {loading && <div className={styles.notice}>Loading addons…</div>}
            {error && <div className={styles.noticeError}>Failed to load addons: {error}</div>}
            {!loading && !error && filtered.length === 0 && (
              <div className={styles.notice}>No addons match the current filters.</div>
            )}
            <div className={styles.grid}>
              {filtered.map(a => (
                <AddonCard
                  key={a.id}
                  addon={a}
                  selected={a.id === selectedId}
                  onSelect={setSelectedId}
                />
              ))}
            </div>
          </div>

          <div className={styles.detailPane}>
            <AddonDetail id={selectedId} onChanged={refresh} />
          </div>
        </div>
      </div>
    </div>
  )
}
