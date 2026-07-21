import { useEffect, useRef } from 'react'
import styles from './ConfirmModal.module.css'

/**
 * ConfirmModal — drop-in replacement for window.confirm.
 *
 * Usage via the useConfirm hook (see useConfirm.js).
 * Props:
 *   open        boolean
 *   title       string
 *   message     string
 *   confirmLabel  string  (default "Confirm")
 *   cancelLabel   string  (default "Cancel")
 *   danger      boolean  (red confirm button)
 *   onConfirm   () => void
 *   onCancel    () => void
 */
export default function ConfirmModal({
  open, title, message,
  confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  danger = false,
  primary = false,
  onConfirm, onCancel,
}) {
  const confirmRef = useRef(null)

  useEffect(() => {
    if (open) confirmRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = e => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') onConfirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onConfirm, onCancel])

  if (!open) return null

  return (
    <div className={styles.overlay} onMouseDown={e => e.target === e.currentTarget && onCancel()}>
      <div className={styles.modal} role="dialog" aria-modal="true">
        {title && <div className={styles.header}>{title}</div>}
        {message && <div className={styles.body}>{message}</div>}
        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onCancel}>{cancelLabel}</button>
          <button
            ref={confirmRef}
            className={`${styles.confirmBtn} ${danger ? styles.danger : ''} ${primary && !danger ? styles.primary : ''}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
