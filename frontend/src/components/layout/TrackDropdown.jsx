import { useState, useRef, useEffect } from 'react'
import styles from './TrackDropdown.module.css'

export default function TrackDropdown({ tracks, activeTrackId, onSelect, disabled = false }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const activeTrack = tracks.find(t => t.id === activeTrackId) || tracks[0] || null

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    function handler(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  if (!tracks.length) return null

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''} ${disabled ? styles.triggerDisabled : ''}`}
        onClick={() => !disabled && setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        id="track-selector-btn"
        title={disabled ? 'Track switching is disabled during an active exam' : 'Switch learning track'}
        style={{
          '--tcolor': activeTrack?.color || 'var(--text-2)',
          '--tdim': activeTrack?.colorDim || 'var(--surface2)'
        }}
      >
        <span className={styles.triggerIcon}>{activeTrack?.icon || '📚'}</span>
        <span className={styles.triggerName}>{activeTrack?.name || 'Select Track'}</span>
        <svg
          className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}
          viewBox="0 0 24 24" width="12" height="12"
          fill="none" stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className={styles.panel} role="listbox" aria-label="Learning Tracks">
          {tracks.map(t => {
            const isActive = t.id === activeTrackId
            const pct = t.stats?.total > 0
              ? Math.round((t.stats.completed / t.stats.total) * 100)
              : 0
            return (
              <button
                key={t.id}
                role="option"
                aria-selected={isActive}
                className={`${styles.option} ${isActive ? styles.optionActive : ''}`}
                style={{ '--tcolor': t.color, '--tdim': t.colorDim }}
                onClick={() => { onSelect(t.id); setOpen(false) }}
              >
                <div className={styles.optionTop}>
                  <span className={styles.optionIcon}>{t.icon}</span>
                  <div className={styles.optionText}>
                    <span className={styles.optionName}>{t.name}</span>
                    <span className={styles.optionTagline}>{t.tagline}</span>
                  </div>
                  <div className={styles.optionMeta}>
                    {isActive && <span className={styles.activeDot} style={{ background: t.color }} />}
                    <span className={styles.optionPct}>{pct}%</span>
                  </div>
                </div>
                <div className={styles.progressTrack}>
                  <div
                    className={styles.progressFill}
                    style={{ width: `${pct}%`, background: t.color }}
                  />
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
