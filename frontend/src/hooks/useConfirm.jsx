import { useState, useCallback, useRef } from 'react'
import ConfirmModal from '@components/shared/ConfirmModal'

/**
 * useConfirm — returns { confirm, ConfirmUI }
 *
 * Usage:
 *   const { confirm, ConfirmUI } = useConfirm()
 *
 *   // Inside JSX:
 *   {ConfirmUI}
 *
 *   // Imperatively (awaitable):
 *   const ok = await confirm({
 *     title: 'Delete item',
 *     message: 'This cannot be undone.',
 *     confirmLabel: 'Delete',
 *     danger: true,
 *   })
 *   if (ok) { ... }
 */
export function useConfirm() {
  const [state, setState] = useState({ open: false })
  const resolveRef = useRef(null)

  const confirm = useCallback((options) => {
    return new Promise(resolve => {
      resolveRef.current = resolve
      setState({ open: true, ...options })
    })
  }, [])

  const handleConfirm = useCallback(() => {
    setState(s => ({ ...s, open: false }))
    resolveRef.current?.(true)
  }, [])

  const handleCancel = useCallback(() => {
    setState(s => ({ ...s, open: false }))
    resolveRef.current?.(false)
  }, [])

  const ConfirmUI = (
    <ConfirmModal
      open={state.open}
      title={state.title}
      message={state.message}
      confirmLabel={state.confirmLabel}
      cancelLabel={state.cancelLabel}
      danger={state.danger}
      primary={state.primary}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  )

  return { confirm, ConfirmUI }
}
