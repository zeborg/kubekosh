import styles from './ExamReport.module.css'

function formatDuration(secs) {
  if (!secs) return '—'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function formatRowTime(secs) {
  if (!secs || secs === 0) return '—'
  const m = Math.floor(secs / 60)
  const s = secs % 60
  if (m > 0) return `${m}m ${s > 0 ? s + 's' : ''}`.trim()
  return `${s}s`
}

const DIFF_COLOR = { Easy: 'var(--green)', Medium: 'var(--amber)', Hard: 'var(--red)' }

export default function ExamReport({ report, bundle, onClose, onRetry }) {
  if (!report) return null

  const { snapshot, durationSecs } = report
  const correct      = snapshot.filter(s => s.status === 'completed')
  const totalWeight  = snapshot.reduce((a, s) => a + (s.weight || 0), 0)
  const earnedWeight = correct.reduce((a, s) => a + (s.weight || 0), 0)
  const pct = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0

  // Group by category
  const byCategory = snapshot.reduce((acc, s) => {
    ;(acc[s.category] = acc[s.category] || []).push(s)
    return acc
  }, {})

  const passed = pct >= 66

  return (
    <div className={styles.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.bundleIcon}>{bundle?.icon || '🎓'}</span>
            <div>
              <div className={styles.examLabel}>Exam Report</div>
              <div className={styles.bundleName}>{bundle?.name}</div>
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* Score hero */}
        <div className={`${styles.hero} ${passed ? styles.passed : styles.failed}`}>
          <div className={styles.scoreRing}>
            <svg viewBox="0 0 80 80" className={styles.ring}>
              <circle cx="40" cy="40" r="34" className={styles.ringTrack} />
              <circle
                cx="40" cy="40" r="34"
                className={styles.ringFill}
                strokeDasharray={`${2 * Math.PI * 34}`}
                strokeDashoffset={`${2 * Math.PI * 34 * (1 - pct / 100)}`}
                style={{ stroke: passed ? 'var(--green)' : 'var(--red)' }}
              />
            </svg>
            <span className={styles.pctText}>{pct}%</span>
          </div>
          <div className={styles.heroMeta}>
            <div className={`${styles.verdict} ${passed ? styles.verdictPass : styles.verdictFail}`}>
              {passed ? '✅ Passed' : '❌ Not Yet Passing'}
            </div>
            <div className={styles.heroStats}>
              <span>{correct.length}/{snapshot.length} correct</span>
              <span>·</span>
              <span>{earnedWeight}/{totalWeight} points</span>
              <span>·</span>
              <span>⏱ {formatDuration(durationSecs)}</span>
            </div>
            <div className={styles.passMark}>Pass mark: 66%</div>
          </div>
        </div>

        {/* Breakdown by category */}
        <div className={styles.breakdown}>
          {Object.entries(byCategory).map(([cat, items]) => (
            <div key={cat} className={styles.catGroup}>
              <div className={styles.catTitle}>{cat}</div>
              {items.map(s => {
                const isCorrect    = s.status === 'completed'
                const isSubmitted  = (s.attempts || 0) > 0
                const rowIcon      = isCorrect ? '✅' : isSubmitted ? '❌' : '⬜'
                return (
                  <div key={s.id} className={`${styles.row} ${isCorrect ? styles.rowDone : isSubmitted ? styles.rowWrong : ''}`}>
                    <span className={styles.rowIcon}>{rowIcon}</span>
                    <span className={styles.rowTitle}>{s.title}</span>
                    <span className={styles.rowDiff} style={{ color: DIFF_COLOR[s.difficulty] }}>
                      {s.difficulty}
                    </span>
                    <span className={styles.rowTime}>
                      {s.time_spent_seconds > 0 && (
                        <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 3, verticalAlign: 'middle', opacity: 0.6 }}>
                          <circle cx="12" cy="12" r="10" />
                          <polyline points="12 6 12 12 16 14" />
                        </svg>
                      )}
                      {formatRowTime(s.time_spent_seconds)}
                    </span>
                    <span className={styles.rowPts}>{isCorrect ? s.weight : 0}/{s.weight} pts</span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className={styles.actions}>
          <button className={styles.retryBtn} onClick={onRetry}>🔄 Start New Exam</button>
          <button className={styles.closeBtn2} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
