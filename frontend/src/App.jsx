import { useState, useCallback, useEffect, useRef } from 'react'
import Sidebar        from '@components/layout/Sidebar'
import ScenarioPanel  from '@components/scenario/ScenarioPanel'
import Terminal       from '@components/scenario/Terminal'
import Header         from '@components/layout/Header'
import BundleNav      from '@components/layout/BundleNav'
import ExamTimer      from '@components/exam/ExamTimer'
import ExamReport     from '@components/exam/ExamReport'
import ExamStartModal from '@components/exam/ExamStartModal'
import ExamHistory    from '@components/exam/ExamHistory'
import AddonsView     from '@components/addons/AddonsView'
import { useAddons }       from '@hooks/useAddons'
import { useClusterHealth } from '@hooks/useClusterHealth'
import { useResizable }     from '@hooks/useResizable'
import { useProgress }      from '@hooks/useProgress'
import { useExamSession }   from '@hooks/useExamSession'
import styles from './App.module.css'

export default function App() {
  const [showAddons, setShowAddons] = useState(false)
  const [activeBundleId, setActiveBundleId] = useState(null)
  const [activeId, setActiveId] = useState(null)

  // examSession is lifted here so both useProgress and useExamSession can share it
  const [examSession, setExamSession] = useState(null)

  // ── Cross-cutting hooks ───────────────────────────────────────────────────
  const { addons, refresh: refreshAddons } = useAddons()
  const { clusterReady } = useClusterHealth()
  const {
    sidebarCollapsed, setSidebarCollapsed, currentSidebarW, onSidebarDragDown,
    termCollapsed,    setTermCollapsed,    currentTermH,    onTermDragDown,
    bundlesCollapsed, setBundlesCollapsed,
  } = useResizable()

  const {
    bundles, setBundles,
    tracks,
    scenarios,
    progress,
    scenario, setScenario,
    loading,
    activeTrackId, setActiveTrackId,
    refreshProgress,
  } = useProgress({
    activeBundleId,
    activeId,
    examSession,
    onBundlesLoaded: (data) => {
      if (data.length > 0 && !activeBundleId) setActiveBundleId(data[0].id)
    },
  })

  const {
    examReport,      setExamReport,
    examModalBundle, setExamModalBundle,
    examProgress,
    showHistory,     setShowHistory,
    startExam,
    submitExam,
    abandonExam,
    syncExamProgress,
  } = useExamSession({ bundles, refreshProgress, examSession, setExamSession })

  const handleProgressUpdate = useCallback(async () => {
    await refreshProgress()
    if (examSession) await syncExamProgress(examSession)
  }, [refreshProgress, syncExamProgress, examSession])

  // ── Addon status polling (drives dashboard buttons in Header) ─────────────
  useEffect(() => {
    const busy = addons.some(a => ['queued', 'installing', 'removing'].includes(a.status))
    const ms   = busy ? 2500 : 15000
    const t    = setInterval(refreshAddons, ms)
    return () => clearInterval(t)
  }, [addons, refreshAddons])

  // ── Sync active bundle when a session is restored / started ───────────────
  useEffect(() => {
    if (examSession?.bundle_id) setActiveBundleId(examSession.bundle_id)
  }, [examSession?.bundle_id])

  // ── Focus mode ────────────────────────────────────────────────────────────
  const [focusMode, setFocusMode] = useState(false)
  const focusSavedState = useRef(null)

  const toggleFocusMode = useCallback(() => {
    if (!focusMode) {
      focusSavedState.current = { sidebarCollapsed, bundlesCollapsed, termCollapsed }
      setSidebarCollapsed(true)
      setBundlesCollapsed(true)
      setTermCollapsed(true)
      setFocusMode(true)
    } else {
      const saved = focusSavedState.current || {}
      setSidebarCollapsed(saved.sidebarCollapsed ?? false)
      setBundlesCollapsed(saved.bundlesCollapsed ?? false)
      setTermCollapsed(saved.termCollapsed ?? false)
      setFocusMode(false)
    }
  }, [focusMode, sidebarCollapsed, bundlesCollapsed, termCollapsed,
      setSidebarCollapsed, setBundlesCollapsed, setTermCollapsed])

  // Exit focus mode if the user manually opens any panel
  useEffect(() => {
    if (focusMode && (!sidebarCollapsed || !bundlesCollapsed || !termCollapsed)) {
      setFocusMode(false)
    }
  }, [sidebarCollapsed, bundlesCollapsed, termCollapsed, focusMode])

  // ── Teardown on scenario restart ──────────────────────────────────────────
  const handleScenarioStart = useCallback(async (scenarioId) => {
    await fetch(`/api/scenarios/${scenarioId}/teardown`, { method: 'POST' }).catch(() => {})
  }, [])

  // ── Derived ───────────────────────────────────────────────────────────────
  const activeBundle      = bundles.find(b => b.id === activeBundleId) || null
  const activeTrack       = tracks.find(t => t.id === activeTrackId)   || null
  const isMcq             = scenario?.type === 'mcq'
  const totalExamWeight   = scenarios.reduce((sum, s) => sum + (s.weight || 0), 0)

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.app}>
      <Header
        clusterReady={clusterReady}
        onShowHistory={() => setShowHistory(true)}
        onShowAddons={() => setShowAddons(true)}
        addons={addons}
        tracks={tracks}
        activeTrackId={activeTrackId}
        onTrackSelect={trackId => {
          if (examSession) return
          setActiveTrackId(trackId)
          const track = tracks.find(t => t.id === trackId)
          if (track?.bundle_ids?.length) {
            setActiveBundleId(track.bundle_ids[0])
            setActiveId(null)
            setScenario(null)
          }
        }}
        onCacheReloaded={refreshProgress}
      />

      <BundleNav
        bundles={bundles}
        activeBundleId={activeBundleId}
        examSession={examSession}
        onSelect={id => {
          if (examSession && id !== examSession.bundle_id) return
          setActiveBundleId(id)
          setActiveId(null)
          setScenario(null)
        }}
        onProgressUpdate={handleProgressUpdate}
        onStartExam={setExamModalBundle}
        collapsed={bundlesCollapsed}
        onToggleCollapse={() => setBundlesCollapsed(c => !c)}
        activeTrack={activeTrack}
      />

      {examSession && (
        <ExamTimer
          session={examSession}
          bundle={activeBundle}
          onSubmit={submitExam}
          onAbandon={abandonExam}
        />
      )}

      <div className={styles.body}>
        <Sidebar
          scenarios={scenarios}
          activeId={activeId}
          onSelect={setActiveId}
          loading={loading}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(c => !c)}
          width={currentSidebarW}
          activeBundleId={activeBundleId}
          onProgressUpdate={handleProgressUpdate}
          isExamMode={!!examSession}
          examProgress={examProgress}
          totalExamWeight={totalExamWeight}
        />

        <div className={styles.sidebarHandle} onMouseDown={onSidebarDragDown} />

        <div className={styles.main}>
          <div className={styles.scenarioWrap}>
            <ScenarioPanel
              scenario={scenario}
              onProgressUpdate={handleProgressUpdate}
              onScenarioStart={handleScenarioStart}
              isExamMode={!!examSession}
              examProgress={examProgress}
              totalExamWeight={totalExamWeight}
              focusMode={focusMode}
              onToggleFocus={toggleFocusMode}
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

      {examModalBundle && (
        <ExamStartModal
          bundle={examModalBundle}
          onStart={(mins, count) => {
            setExamModalBundle(null)
            startExam(examModalBundle.id, mins, count)
          }}
          onCancel={() => setExamModalBundle(null)}
        />
      )}

      {showHistory && (
        <ExamHistory onClose={() => setShowHistory(false)} />
      )}

      {showAddons && (
        <AddonsView onClose={() => setShowAddons(false)} />
      )}

      <footer className={styles.footer}>
        <div>&copy; {new Date().getFullYear()} The KubeKosh Project &bull; All rights reserved</div>
        <div>
          Made with <span className={styles.heart}>❤️</span> by{' '}
          <a href="https://github.com/zeborg" target="_blank" rel="noopener noreferrer" className={styles.footerLink}>
            zeborg
          </a>
        </div>
      </footer>
    </div>
  )
}
