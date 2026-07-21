import { useState, useEffect } from 'react'
import styles from './ExamHistory.module.css'

const DIFF_COLOR = { Easy: 'var(--green)', Medium: 'var(--amber)', Hard: 'var(--red)' }

function formatDuration(secs) {
  if (!secs && secs !== 0) return '—'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z')
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
}

function formatRowTime(secs) {
  if (!secs || secs === 0) return '—'
  const m = Math.floor(secs / 60)
  const s = secs % 60
  if (m > 0) return `${m}m ${s > 0 ? s + 's' : ''}`.trim()
  return `${s}s`
}

function ScoreRing({ pct, passed, size = 72 }) {
  const r = (size / 2) - 7
  const circ = 2 * Math.PI * r
  return (
    <div className={styles.ringWrap} style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--surface3)" strokeWidth="6" />
        <circle
          cx={size/2} cy={size/2} r={r}
          fill="none"
          stroke={passed ? 'var(--green)' : pct > 0 ? 'var(--red)' : 'var(--surface3)'}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - pct / 100)}
          style={{ transition: 'stroke-dashoffset 0.6s ease' }}
        />
      </svg>
      <span className={styles.ringPct}>{pct}%</span>
    </div>
  )
}

function AttemptListItem({ attempt, active, onClick }) {
  const isAbandoned = attempt.status === 'abandoned'
  const hasSnapshot = attempt.snapshot?.length > 0
  return (
    <button
      className={`${styles.listItem} ${active ? styles.listItemActive : ''} ${isAbandoned ? styles.listItemAbandoned : ''}`}
      onClick={onClick}
    >
      <div className={styles.listItemLeft}>
        <span className={styles.listIcon}>{attempt.bundle_icon}</span>
        <div className={styles.listMeta}>
          <span className={styles.listBundle}>{attempt.bundle_name}</span>
          <span className={styles.listDate}>{formatDate(attempt.started_at)}</span>
        </div>
      </div>
      <div className={styles.listItemRight}>
        {isAbandoned ? (
          <span className={styles.badgeAbandoned}>Abandoned</span>
        ) : hasSnapshot ? (
          <>
            <span className={attempt.passed ? styles.badgePass : styles.badgeFail}>
              {attempt.passed ? 'Passed' : 'Failed'}
            </span>
            <span className={styles.listPct}>{attempt.pct}%</span>
          </>
        ) : (
          <span className={styles.badgeAbandoned}>No data</span>
        )}
      </div>
    </button>
  )
}

function AttemptDetail({ attempt }) {
  if (!attempt) {
    return (
      <div className={styles.detailEmpty}>
        <div className={styles.detailEmptyIcon}>📋</div>
        <div className={styles.detailEmptyText}>Select an attempt to see its report</div>
      </div>
    )
  }

  const isAbandoned = attempt.status === 'abandoned'
  const hasSnapshot = attempt.snapshot?.length > 0

  // Group by category
  const byCategory = (attempt.snapshot || []).reduce((acc, s) => {
    ;(acc[s.category] = acc[s.category] || []).push(s)
    return acc
  }, {})

  return (
    <div className={styles.detail}>
      {/* Detail header */}
      <div className={styles.detailHeader}>
        <span className={styles.detailIcon}>{attempt.bundle_icon}</span>
        <div>
          <div className={styles.detailLabel}>Exam Report</div>
          <div className={styles.detailBundle}>{attempt.bundle_name}</div>
        </div>
        <div className={styles.detailDates}>
          <span className={styles.detailDateRow}>
            <span className={styles.detailDateLabel}>Started</span>
            <span className={styles.detailDateVal}>{formatDate(attempt.started_at)}</span>
          </span>
          <span className={styles.detailDateRow}>
            <span className={styles.detailDateLabel}>Ended</span>
            <span className={styles.detailDateVal}>{formatDate(attempt.submitted_at)}</span>
          </span>
        </div>
      </div>

      {/* Score hero */}
      {isAbandoned ? (
        <div className={styles.abandonedHero}>
          <span className={styles.abandonedIcon}>🚫</span>
          <div>
            <div className={styles.abandonedTitle}>Exam Abandoned</div>
            <div className={styles.abandonedSub}>
              {hasSnapshot
                ? `${attempt.completedCount} of ${attempt.scenarioCount} scenarios were completed before abandoning`
                : 'No progress was recorded'}
              {attempt.duration_secs
                ? ` · ${formatDuration(attempt.duration_secs)} elapsed`
                : ''}
            </div>
          </div>
        </div>
      ) : (
        <div className={`${styles.hero} ${attempt.passed ? styles.heroPassed : styles.heroFailed}`}>
          <ScoreRing pct={attempt.pct} passed={attempt.passed} />
          <div className={styles.heroMeta}>
            <div className={`${styles.verdict} ${attempt.passed ? styles.verdictPass : styles.verdictFail}`}>
              {attempt.passed ? '✅ Passed' : '❌ Not Yet Passing'}
            </div>
            <div className={styles.heroStats}>
              <span>{attempt.completedCount}/{attempt.scenarioCount} scenarios</span>
              <span>·</span>
              <span>{attempt.earnedWeight}/{attempt.totalWeight} pts</span>
              <span>·</span>
              <span>⏱ {formatDuration(attempt.duration_secs)}</span>
            </div>
            <div className={styles.passMark}>Pass mark: 66%</div>
          </div>
        </div>
      )}

      {/* Scenario breakdown */}
      {hasSnapshot && (
        <div className={styles.breakdown}>
          {Object.entries(byCategory).map(([cat, items]) => (
            <div key={cat} className={styles.catGroup}>
              <div className={styles.catTitle}>{cat}</div>
              {items.map(s => {
                const isCorrect   = s.status === 'completed'
                const isSubmitted = (s.attempts || 0) > 0
                const rowIcon     = isCorrect ? '✅' : isSubmitted ? '❌' : '⬜'
                return (
                  <div key={s.id} className={`${styles.row} ${isCorrect ? styles.rowDone : ''}`}>
                    <span className={styles.rowIcon}>{rowIcon}</span>
                    <span className={styles.rowTitle}>{s.title}</span>
                    <span className={styles.rowDiff} style={{ color: DIFF_COLOR[s.difficulty] }}>
                      {s.difficulty}
                    </span>
                    <span className={styles.rowTime}>
                      {(s.time_spent_seconds > 0) && (
                        <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 3, verticalAlign: 'middle', opacity: 0.6 }}>
                          <circle cx="12" cy="12" r="10" />
                          <polyline points="12 6 12 12 16 14" />
                        </svg>
                      )}
                      {formatRowTime(s.time_spent_seconds)}
                    </span>
                    <span className={styles.rowPts}>
                      {isCorrect ? s.weight : 0}/{s.weight} pts
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}

      {!hasSnapshot && (
        <div className={styles.noSnapshot}>No scenario data recorded for this session.</div>
      )}
    </div>
  )
}

export default function ExamHistory({ onClose }) {
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)

  useEffect(() => {
    fetch('/api/sessions/history')
      .then(r => r.json())
      .then(data => {
        setHistory(data)
        if (data.length > 0) setSelected(data[0])
      })
      .catch(() => setHistory([]))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className={styles.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal}>
        {/* Modal header */}
        <div className={styles.modalHeader}>
          <div className={styles.modalTitle}>
            <span className={styles.modalTitleIcon}>📋</span>
            Exam History
          </div>
          <div className={styles.modalMeta}>
            {!loading && (
              <span className={styles.attemptCount}>
                {history.length} attempt{history.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close exam history">✕</button>
        </div>

        {/* Body: two-panel layout */}
        <div className={styles.body}>
          {/* Left: attempt list */}
          <div className={styles.list}>
            {loading && (
              <div className={styles.loadingWrap}>
                {[...Array(4)].map((_, i) => (
                  <div key={i} className={styles.skeleton} style={{ animationDelay: `${i * 0.1}s` }} />
                ))}
              </div>
            )}
            {!loading && history.length === 0 && (
              <div className={styles.emptyList}>
                <div className={styles.emptyIcon}>🎓</div>
                <div className={styles.emptyText}>No exam attempts yet</div>
                <div className={styles.emptySub}>Complete or abandon an exam to see it here</div>
              </div>
            )}
            {!loading && history.map(a => (
              <AttemptListItem
                key={a.id}
                attempt={a}
                active={selected?.id === a.id}
                onClick={() => setSelected(a)}
              />
            ))}
          </div>

          {/* Right: detail */}
          <div className={styles.detailWrap}>
            <AttemptDetail attempt={selected} />
          </div>
        </div>
      </div>
    </div>
  )
}
