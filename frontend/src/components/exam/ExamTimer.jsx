import { useState, useEffect, useCallback, useRef } from 'react'
import styles from './ExamTimer.module.css'
import { useConfirm } from '@hooks/useConfirm'

function formatTime(secs) {
  if (secs < 0) secs = 0
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
}

export default function ExamTimer({ session, bundle, submittedCount, onSubmit, onAbandon }) {
  const [elapsed, setElapsed] = useState(0)
  const autoSubmitted = useRef(false)
  // session.exam_minutes is set at start time with the user's custom value
  const durationSecs = (session?.exam_minutes || bundle?.exam_minutes || 120) * 60

  useEffect(() => {
    if (!session) return
    autoSubmitted.current = false
    const startedAt = new Date(session.started_at + (session.started_at.endsWith('Z') ? '' : 'Z'))
    
    const tick = () => {
      const el = Math.floor((Date.now() - startedAt.getTime()) / 1000)
      if (el >= durationSecs && !autoSubmitted.current) {
        autoSubmitted.current = true
        setElapsed(durationSecs)
        onSubmit()
      } else if (!autoSubmitted.current) {
        setElapsed(el)
      }
    }
    
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [session, durationSecs, onSubmit])

  const remaining = durationSecs - elapsed
  const pct = Math.min(100, (elapsed / durationSecs) * 100)
  const urgent = remaining < 600 // < 10 min

  const { confirm, ConfirmUI } = useConfirm()

  const handleSubmit = useCallback(async () => {
    const ok = await confirm({
      title: 'Submit Exam',
      message: `Submit exam now?\n\n${submittedCount ?? session.completedCount ?? 0} of ${session.scenarioCount || '?'} scenarios submitted.`,
      confirmLabel: 'Submit',
    })
    if (!ok) return
    onSubmit()
  }, [session, onSubmit, confirm])

  const handleAbandon = useCallback(async () => {
    const ok = await confirm({
      title: 'Abandon Exam',
      message: 'Abandon this exam?\n\nYour progress will be saved but no score report will be generated.',
      confirmLabel: 'Abandon',
      danger: true,
    })
    if (!ok) return
    onAbandon()
  }, [onAbandon, confirm])

  if (!session) return null

  return (
    <>
    <div className={`${styles.timer} ${urgent ? styles.urgent : ''}`}>
      <div className={styles.left}>
        <span className={styles.icon}>⏱</span>
        <div className={styles.meta}>
          <span className={styles.label}>EXAM MODE</span>
          <span className={styles.bundleName}>{bundle?.name}</span>
        </div>
      </div>

      <div className={styles.center}>
        <div className={styles.timeDisplay}>
          <span className={styles.elapsed}>{formatTime(elapsed)}</span>
          <span className={styles.sep}>/</span>
          <span className={styles.total}>{formatTime(durationSecs)}</span>
          {urgent && <span className={styles.urgentTag}>⚠ Running out of time</span>}
        </div>
        <div className={styles.bar}>
          <div className={styles.fill} style={{ width: `${pct}%` }} />
        </div>
        <div className={styles.progress}>
          {submittedCount ?? session.completedCount ?? 0} / {session.scenarioCount || '?'} submitted
        </div>
      </div>

      <div className={styles.right}>
        <button className={styles.abandonBtn} onClick={handleAbandon} title="Abandon exam (no score report)">
          ✕ Abandon
        </button>
        <button className={styles.submitBtn} onClick={handleSubmit}>
          ✓ Submit Exam
        </button>
      </div>
    </div>
    {ConfirmUI}
    </>
  )
}
