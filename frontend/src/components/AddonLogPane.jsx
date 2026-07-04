import { useEffect, useRef } from 'react'
import styles from './AddonsView.module.css'

// Read-only, auto-scrolling pane that renders streamed install/remove output.
// `meta` lines (command headers, errors) are styled distinctly from stdout/stderr.
export default function AddonLogPane({ logs }) {
  const endRef = useRef(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [logs])

  if (!logs || logs.length === 0) {
    return <div className={styles.logEmpty}>Waiting for output…</div>
  }

  return (
    <div className={styles.logPane}>
      {logs.map((l, i) => (
        <div
          key={i}
          className={`${styles.logLine} ${
            l.stream === 'meta' ? styles.logMeta
              : l.stream === 'stderr' ? styles.logErr : ''
          }`}
        >
          {l.line}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  )
}
