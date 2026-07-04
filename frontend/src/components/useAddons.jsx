import { useState, useEffect, useCallback } from 'react'

// Fetches the addon catalog (GET /api/addons) and exposes a refresh().
// Phase 2 is read-only; Phase 3 reuses refresh() after install/remove actions.
export function useAddons() {
  const [addons, setAddons] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/addons')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const contentType = res.headers.get('content-type')
      if (!contentType?.includes('application/json')) {
        throw new Error('Expected JSON response')
      }
      setAddons(await res.json())
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  return { addons, loading, error, refresh }
}

// Fetches a single addon's detail (GET /api/addons/:id) including its
// resolved install_plan and dependents. Returns null until loaded.
export function useAddonDetail(id) {
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!id) { setDetail(null); return }
    setLoading(true)
    try {
      const res = await fetch(`/api/addons/${id}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const contentType = res.headers.get('content-type')
      if (!contentType?.includes('application/json')) {
        throw new Error('Expected JSON response')
      }
      setDetail(await res.json())
    } catch {
      setDetail(null)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { refresh() }, [refresh])

  return { detail, loading, refresh }
}
