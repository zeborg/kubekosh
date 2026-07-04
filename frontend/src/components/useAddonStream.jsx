import { useState, useEffect, useRef, useCallback } from 'react'

// Subscribes to an addon's SSE stream (GET /api/addons/:id/stream) while
// `enabled` is true. Collects log lines and the latest status per addon in the
// chain (an install can touch dependencies, each tagged by `addon`).
//
// EventSource reconnects automatically; we reset logs whenever the subscribed
// id changes. onStatus fires for every status event so callers can refresh the
// catalog / detail.
export function useAddonStream(id, enabled, onStatus) {
  const [logs, setLogs] = useState([])
  const [statuses, setStatuses] = useState({}) // addonId -> status
  const [connected, setConnected] = useState(false)
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus

  // Reset accumulated logs when switching addon.
  useEffect(() => { setLogs([]); setStatuses({}) }, [id])

  useEffect(() => {
    if (!enabled || !id) return

    const es = new EventSource(`/api/addons/${id}/stream`)

    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false) // browser auto-reconnects

    es.addEventListener('log', (e) => {
      try {
        const d = JSON.parse(e.data)
        setLogs((prev) => [...prev, d])
      } catch { /* ignore malformed frame */ }
    })

    es.addEventListener('status', (e) => {
      try {
        const d = JSON.parse(e.data)
        setStatuses((prev) => ({ ...prev, [d.addon]: d.status }))
        onStatusRef.current?.(d)
      } catch { /* ignore */ }
    })

    return () => { es.close(); setConnected(false) }
  }, [id, enabled])

  const clear = useCallback(() => setLogs([]), [])

  return { logs, statuses, connected, clear }
}
