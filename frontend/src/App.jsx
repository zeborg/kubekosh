import { useState, useEffect, useCallback, useRef } from 'react'
import Sidebar from './components/Sidebar'
import ScenarioPanel from './components/ScenarioPanel'
import Terminal from './components/Terminal'
import Header from './components/Header'
import BundleNav from './components/BundleNav'
import ExamTimer from './components/ExamTimer'
import ExamReport from './components/ExamReport'
import ExamStartModal from './components/ExamStartModal'
import styles from './App.module.css'

const MIN_SIDEBAR_W = 180
const MAX_SIDEBAR_W = 560
const DEFAULT_SIDEBAR_W = 280
const SIDEBAR_COLLAPSE_PX = 100
const SIDEBAR_COLLAPSED_W = 40

const MIN_TERM_H = 36
const MAX_TERM_H = 600
const DEFAULT_TERM_H = 280
const TERM_COLLAPSE_PX = 60

export default function App() {
  const [bundles, setBundles] = useState([])
  const [activeBundleId, setActiveBundleId] = useState(null)

  const [scenarios, setScenarios] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [scenario, setScenario] = useState(null)
  const [progress, setProgress] = useState({})
  const [clusterReady, setClusterReady] = useState(false)
  const [loading, setLoading] = useState(true)

  // ── Exam mode ─────────────────────────────────────────────────────────────
  const [examSession, setExamSession] = useState(null)   // active session object
  const [examReport, setExamReport] = useState(null)     // submitted report
  const [examModalBundle, setExamModalBundle] = useState(null) // bundle for start/retry modal

  // Sidebar resize / collapse
  const [sidebarW, setSidebarW] = useState(DEFAULT_SIDEBAR_W)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const sbDragging = useRef(false)
  const sbDragX0 = useRef(0)
  const sbDragW0 = useRef(0)

  // Terminal resize / collapse
  const [termH, setTermH] = useState(300)
  const [termCollapsed, setTermCollapsed] = useState(false)
  const [bundlesCollapsed, setBundlesCollapsed] = useState(false)
  const tmDragging = useRef(false)
  const tmDragY0 = useRef(0)
  const tmDragH0 = useRef(0)

  // Track previous scenario id to teardown on switch
  const prevActiveIdRef = useRef(null)

  // ── Cluster health ────────────────────────────────────────────────────────
  useEffect(() => {
    async function check() {
      try {
        const d = await fetch('/api/health').then(r => r.json())
        setClusterReady(d.cluster === 'ready')
      } catch { setClusterReady(false) }
    }
    check()
    const t = setInterval(check, 8000)
    return () => clearInterval(t)
  }, [])

  // ── Load bundles (once) ───────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/bundles')
      .then(r => r.json())
      .then(data => {
        setBundles(data)
        if (data.length > 0) setActiveBundleId(data[0].id)
      })
      .catch(console.error)
  }, [])

  // ── Restore active exam session on load ───────────────────────────────────
  useEffect(() => {
    fetch('/api/sessions/active')
      .then(r => r.json())
      .then(s => {
        if (s) {
          setExamSession(s)
          setActiveBundleId(s.bundle_id)
        }
      })
      .catch(() => { })
  }, [])

  // ── Load scenarios for active bundle ─────────────────────────────────────
  useEffect(() => {
    if (!activeBundleId) return
    setLoading(true)
    setActiveId(null)
    setScenario(null)
    const url = `/api/scenarios?bundle=${activeBundleId}`
    fetch(url)
      .then(r => r.json())
      .then(data => {
        setScenarios(data)
        setProgress(Object.fromEntries(data.map(s => [s.id, s.progress])))
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [activeBundleId])

  // ── Load full scenario when selected — teardown previous, load new ─────────
  useEffect(() => {
    if (!activeId) return

    // Teardown the previously active scenario's cluster state on switch
    const prevId = prevActiveIdRef.current
    if (prevId && prevId !== activeId) {
      fetch(`/api/scenarios/${prevId}/teardown`, { method: 'POST' }).catch(() => { })
    }
    prevActiveIdRef.current = activeId

    setScenario(null)
    fetch(`/api/scenarios/${activeId}`)
      .then(r => r.json())
      .then(s => {
        setScenario(s)
        // Feature 3: sync terminal context when scenario selected
        fetch(`/api/scenarios/${activeId}/context`, { method: 'POST' }).catch(() => { })
      })
      .catch(console.error)
  }, [activeId])

  const refreshProgress = useCallback(async () => {
    const [bundleData, scenarioData] = await Promise.all([
      fetch('/api/bundles').then(r => r.json()),
      fetch(`/api/scenarios?bundle=${activeBundleId}`).then(r => r.json()),
    ])
    setBundles(bundleData)
    setScenarios(scenarioData)
    setProgress(Object.fromEntries(scenarioData.map(s => [s.id, s.progress])))
    if (activeId) {
      const d2 = await fetch(`/api/scenarios/${activeId}`).then(r => r.json())
      setScenario(d2)
    }
    // Refresh exam session completion count
    if (examSession) {
      const updated = await fetch('/api/sessions/active').then(r => r.json()).catch(() => null)
      if (updated) setExamSession(updated)
    }
  }, [activeBundleId, activeId, examSession])

  // ── Exam actions ──────────────────────────────────────────────────────────
  const startExam = useCallback(async (bundleId, customMinutes) => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bundleId, examMinutes: customMinutes }),
    }).then(r => r.json())
    // refresh to get scenarioCount
    const active = await fetch('/api/sessions/active').then(r => r.json())
    setExamSession(active)
    setActiveBundleId(bundleId)
    setActiveId(null)
    setScenario(null)
  }, [])

  const submitExam = useCallback(async () => {
    if (!examSession) return
    const result = await fetch(`/api/sessions/${examSession.id}/submit`, { method: 'POST' })
      .then(r => r.json())
    const bundle = bundles.find(b => b.id === examSession.bundle_id)
    setExamReport({ ...result, bundle })
    setExamSession(null)
    refreshProgress()
  }, [examSession, bundles, refreshProgress])

  const abandonExam = useCallback(async () => {
    if (!examSession) return
    await fetch(`/api/sessions/${examSession.id}/abandon`, { method: 'POST' }).catch(() => { })
    setExamSession(null)
    refreshProgress()
  }, [examSession, refreshProgress])

  // ── Teardown when restarting a scenario (Feature 2) ───────────────────────
  const handleScenarioStart = useCallback(async (scenarioId) => {
    // Run teardown first to clean cluster state
    await fetch(`/api/scenarios/${scenarioId}/teardown`, { method: 'POST' }).catch(() => { })
    // Then setup will be called by ScenarioPanel as before
  }, [])

  // ── Sidebar drag ─────────────────────────────────────────────────────────
  const onSidebarDragDown = useCallback((e) => {
    e.preventDefault()
    sbDragging.current = true
    sbDragX0.current = e.clientX
    sbDragW0.current = sidebarCollapsed ? SIDEBAR_COLLAPSED_W : sidebarW

    function onMove(ev) {
      if (!sbDragging.current) return
      const newW = sbDragW0.current + (ev.clientX - sbDragX0.current)
      if (newW < SIDEBAR_COLLAPSE_PX) {
        setSidebarCollapsed(true)
      } else {
        setSidebarCollapsed(false)
        setSidebarW(Math.min(MAX_SIDEBAR_W, Math.max(MIN_SIDEBAR_W, newW)))
      }
    }
    function onUp() {
      sbDragging.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [sidebarCollapsed, sidebarW])

  // ── Terminal drag ────────────────────────────────────────────────────────
  const onTermDragDown = useCallback((e) => {
    e.preventDefault()
    tmDragging.current = true
    tmDragY0.current = e.clientY
    tmDragH0.current = termCollapsed ? MIN_TERM_H : termH

    function onMove(ev) {
      if (!tmDragging.current) return
      const newH = tmDragH0.current + (tmDragY0.current - ev.clientY)
      if (newH < TERM_COLLAPSE_PX) {
        setTermCollapsed(true)
      } else {
        setTermCollapsed(false)
        setTermH(Math.min(MAX_TERM_H, Math.max(MIN_TERM_H + 40, newH)))
      }
    }
    function onUp() {
      tmDragging.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [termCollapsed, termH])

  const currentSidebarW = sidebarCollapsed ? SIDEBAR_COLLAPSED_W : sidebarW
  const currentTermH = termCollapsed ? MIN_TERM_H : termH
  const activeBundle = bundles.find(b => b.id === activeBundleId) || null
  const isMcq = scenario?.type === 'mcq'

  return (
    <div className={styles.app}>
      <Header clusterReady={clusterReady} />

      {/* Bundle navigation bar */}
      <BundleNav
        bundles={bundles}
        activeBundleId={activeBundleId}
        examSession={examSession}
        onSelect={id => {
          // In exam mode, only allow switching within the exam bundle
          if (examSession && id !== examSession.bundle_id) return
          setActiveBundleId(id); setActiveId(null); setScenario(null)
        }}
        onProgressUpdate={refreshProgress}
        onStartExam={setExamModalBundle}
        collapsed={bundlesCollapsed}
        onToggleCollapse={() => setBundlesCollapsed(c => !c)}
      />

      {/* Exam timer bar */}
      {examSession && (
        <ExamTimer
          session={examSession}
          bundle={activeBundle}
          onSubmit={submitExam}
          onAbandon={abandonExam}
        />
      )}

      <div className={styles.body}>
        {/* Sidebar */}
        <Sidebar
          scenarios={scenarios}
          activeId={activeId}
          onSelect={setActiveId}
          loading={loading}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(c => !c)}
          width={currentSidebarW}
          activeBundleId={activeBundleId}
          onProgressUpdate={refreshProgress}
        />

        {/* Sidebar resize handle */}
        <div className={styles.sidebarHandle} onMouseDown={onSidebarDragDown} />

        {/* Main area */}
        <div className={styles.main}>
          <div className={styles.scenarioWrap}>
            <ScenarioPanel
              scenario={scenario}
              onProgressUpdate={refreshProgress}
              onScenarioStart={handleScenarioStart}
              isExamMode={!!examSession}
            />
          </div>

          {!isMcq && (
            <div className={styles.termHandle} onMouseDown={onTermDragDown} />
          )}

          {!isMcq && (
            <div className={styles.terminalWrap} style={{ height: currentTermH }}>
              <Terminal
                collapsed={termCollapsed}
                onToggleCollapse={() => setTermCollapsed(c => !c)}
              />
            </div>
          )}
        </div>
      </div>

      {/* Exam report modal */}
      {examReport && (
        <ExamReport
          report={examReport}
          bundle={examReport.bundle}
          onClose={() => setExamReport(null)}
          onRetry={() => {
            setExamReport(null)
            setExamModalBundle(examReport.bundle)
          }}
        />
      )}

      {/* Exam start modal */}
      {examModalBundle && (
        <ExamStartModal
          bundle={examModalBundle}
          onStart={mins => {
            setExamModalBundle(null)
            startExam(examModalBundle.id, mins)
          }}
          onCancel={() => setExamModalBundle(null)}
        />
      )}
      <footer className={styles.footer}>
        <div>&copy; {new Date().getFullYear()} The KubeKosh Project &bull; All rights reserved</div>
        <div>
          Made with <span className={styles.heart}>❤️</span> by <a href="https://github.com/zeborg" target="_blank" rel="noopener noreferrer" className={styles.footerLink}>zeborg</a>
        </div>
      </footer>
    </div>
  )
}
