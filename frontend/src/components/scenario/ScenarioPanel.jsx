import { useState, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import styles from './ScenarioPanel.module.css'
import { useConfirm } from '@hooks/useConfirm'

// Inline markdown: renders without a wrapping <p> — safe for buttons/spans
const inlineComponents = {
  p: ({ children }) => <>{children}</>,
  code: ({ children }) => <code className="inline-code">{children}</code>,
}
function InlineMd({ children }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={inlineComponents}>
      {children}
    </ReactMarkdown>
  )
}

async function resetProgress(scope, opts) {
  await fetch('/api/progress/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, ...opts }),
  })
}

export default function ScenarioPanel({ scenario, onProgressUpdate, onScenarioStart, isExamMode, examProgress, examSubmittedIds, onExamSubmit, totalExamWeight, focusMode, onToggleFocus }) {
  const [tab, setTab] = useState('problem')
  const [setupState, setSetupState] = useState('idle') // idle | running | done | error
  const [validating, setValidating] = useState(false)
  const { confirm, ConfirmUI } = useConfirm()
  const [validResult, setValidResult] = useState(null)
  const [selectedOption, setSelectedOption] = useState(null)
  const [mcqResult, setMcqResult] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [hintsRevealed, setHintsRevealed] = useState([])
  const [copiedCmd, setCopiedCmd] = useState(null)
  const [localTimeSpent, setLocalTimeSpent] = useState(0)

  // Reset state when scenario changes
  useEffect(() => {
    setTab('problem')
    setSetupState('idle')
    setValidResult(null)
    setSelectedOption(null)
    setMcqResult(null)
    setHintsRevealed([])
  }, [scenario?.id])

  const timeSpentRef = useRef(0)
  const lastScenarioIdRef = useRef(null)

  // Sync ref with prop on scenario change (or when prop changes externally)
  useEffect(() => {
    const propTime = scenario?.progress?.time_spent_seconds || 0
    if (lastScenarioIdRef.current !== scenario?.id) {
      lastScenarioIdRef.current = scenario?.id
      timeSpentRef.current = propTime
      setLocalTimeSpent(propTime)
    } else if (propTime > timeSpentRef.current) {
      timeSpentRef.current = propTime
      setLocalTimeSpent(propTime)
    }
  }, [scenario?.id, scenario?.progress?.time_spent_seconds])

  const prevIsExamModeRef = useRef(isExamMode)

  // Reset timer state if we exit exam mode
  useEffect(() => {
    if (prevIsExamModeRef.current && !isExamMode) {
      timeSpentRef.current = 0
      setLocalTimeSpent(0)
    }
    prevIsExamModeRef.current = isExamMode
  }, [isExamMode])

  useEffect(() => {
    // Only track time in exam mode, and only if the scenario isn't already completed in the exam
    const examCompleted = isExamMode && examProgress?.[scenario?.id]?.status === 'completed'
    if (!isExamMode || !scenario || examCompleted) return

    // Begin tracking immediately: if progress database has no started_at record yet, initialize it
    if (!scenario.progress?.started_at) {
      fetch(`/api/scenarios/${scenario.id}/time`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ time_spent_seconds: timeSpentRef.current })
      }).then(() => {
        onProgressUpdate?.()
      }).catch(() => {})
    }

    const timer = setInterval(() => {
      timeSpentRef.current += 1
      setLocalTimeSpent(timeSpentRef.current)
      if (timeSpentRef.current % 10 === 0) {
        fetch(`/api/scenarios/${scenario.id}/time`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ time_spent_seconds: timeSpentRef.current })
        }).catch(() => {})
      }
    }, 1000)

    return () => {
      clearInterval(timer)
      fetch(`/api/scenarios/${scenario.id}/time`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ time_spent_seconds: timeSpentRef.current }),
        keepalive: true
      }).catch(() => {})
    }
  }, [scenario?.id, scenario?.progress?.status, isExamMode, examProgress, onProgressUpdate])

  async function runSetup() {
    setSetupState('running')
    try {
      // Feature 2: teardown first to ensure clean cluster state
      await fetch(`/api/scenarios/${scenario.id}/teardown`, { method: 'POST' }).catch(() => {})
      await onScenarioStart?.(scenario.id)
      await fetch(`/api/scenarios/${scenario.id}/setup`, { method: 'POST' })
      setSetupState('done')
    } catch {
      setSetupState('error')
    }
  }

  async function validate() {
    // In exam mode, show a confirmation modal before submitting
    if (isExamMode) {
      const ok = await confirm({
        title: 'Submit Scenario',
        message: `Submit "${scenario.title}" for this exam?\n\nOnce submitted, you cannot resubmit or reset this scenario for the ongoing exam session. Results will be revealed in the exam report.`,
        confirmLabel: 'Submit',
        primary: true,
      })
      if (!ok) return
    }
    setValidating(true)
    setValidResult(null)
    try {
      const r = await fetch(`/api/scenarios/${scenario.id}/validate`, { method: 'POST' })
      const d = await r.json()
      setValidResult(d)
      if (isExamMode) onExamSubmit?.(scenario.id)
      onProgressUpdate()
    } catch {
      setValidResult({ error: true })
    }
    setValidating(false)
  }

  async function submitMCQ() {
    if (!selectedOption) return
    // In exam mode, show a confirmation modal before submitting
    if (isExamMode) {
      const ok = await confirm({
        title: 'Submit Answer',
        message: `Submit your answer for "${scenario.title}"?\n\nOnce submitted, you cannot resubmit or change your answer for the ongoing exam session. Results will be revealed in the exam report.`,
        confirmLabel: 'Submit',
        primary: true,
      })
      if (!ok) return
    }
    setSubmitting(true)
    try {
      const r = await fetch(`/api/scenarios/${scenario.id}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected: selectedOption })
      })
      const d = await r.json()
      setMcqResult(d)
      if (isExamMode) onExamSubmit?.(scenario.id)
      onProgressUpdate()
    } catch {}
    setSubmitting(false)
  }

  function copyCmd(cmd, idx) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(cmd).then(() => {
        setCopiedCmd(idx)
        setTimeout(() => setCopiedCmd(null), 1800)
      })
    } else {
      const textArea = document.createElement("textarea")
      textArea.value = cmd
      textArea.style.position = "fixed"
      textArea.style.left = "-999999px"
      textArea.style.top = "-999999px"
      document.body.appendChild(textArea)
      textArea.focus()
      textArea.select()
      try {
        document.execCommand('copy')
        setCopiedCmd(idx)
        setTimeout(() => setCopiedCmd(null), 1800)
      } catch (err) {
        console.error('Fallback copy failed', err)
      }
      textArea.remove()
    }
  }

  if (!scenario) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyIcon}>⎈</div>
        <div className={styles.emptyTitle}>Select a scenario</div>
        <div className={styles.emptySub}>Choose from the left panel to start practising</div>
      </div>
    )
  }

  const isCompleted = scenario.progress?.status === 'completed'
  // In exam mode, use exam-specific completion status
  const isExamCompleted = isExamMode && examProgress?.[scenario.id]?.status === 'completed'
  // A scenario is "submitted" if the App-level Set says so (covers pass AND fail)
  const isExamSubmitted = isExamMode && !!(examSubmittedIds?.has(scenario.id) || isExamCompleted)

  return (
    <div className={styles.panel}>
      {ConfirmUI}
      {/* Scenario header */}
      <div className={styles.scenarioHeader}>
        <div className={styles.scenarioMeta}>
          <span className={styles.category}>{scenario.category}</span>
          {!isExamMode && (
            <span className={`${styles.diff} ${styles[scenario.difficulty?.toLowerCase()]}`}>
              {scenario.difficulty}
            </span>
          )}
          <span className={styles.typeTag}>{scenario.type === 'mcq' ? 'Multiple Choice' : 'Hands-on Task'}</span>
          {!isExamMode && <span className={styles.weight}>{scenario.weight} pts</span>}
          {isExamMode && totalExamWeight > 0 && (
            <span className={styles.examWeight}>
              {Math.round((scenario.weight / totalExamWeight) * 100)}% weight
            </span>
          )}
        </div>
        <div className={styles.titleRow}>
          <div className={styles.scenarioTitle}>{scenario.title}</div>
          {onToggleFocus && !isExamMode && (
            <button
              className={focusMode ? styles.focusBtnActive : styles.focusBtn}
              onClick={onToggleFocus}
              title={focusMode ? 'Exit focus mode' : 'Focus mode — hide sidebar, terminal & nav'}
            >
              {focusMode ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="10" y1="14" x2="3" y2="21" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              )}
            </button>
          )}
          {isExamMode && scenario.progress?.started_at && (
            <div className={styles.progressStats}>
              <div className={styles.statItem}>
                <span className={styles.statLabel}>Started:</span>
                <span className={styles.statVal}>
                  {new Date(scenario.progress.started_at).toLocaleString()}
                </span>
              </div>
              <span className={styles.statSeparator}>•</span>
              <div className={styles.statItem}>
                <span className={styles.statLabel}>Time Spent:</span>
                <span className={styles.statVal}>
                  {(() => {
                    const m = Math.floor(localTimeSpent / 60)
                    const s = localTimeSpent % 60
                    if (m > 0) return `${m}m ${s}s`
                    return `${s}s`
                  })()}
                </span>
              </div>
            </div>
          )}
          {onToggleFocus && isExamMode && (
            <button
              className={focusMode ? styles.focusBtnActive : styles.focusBtn}
              onClick={onToggleFocus}
              title={focusMode ? 'Exit focus mode' : 'Focus mode — hide sidebar, terminal & nav'}
            >
              {focusMode ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="10" y1="14" x2="3" y2="21" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              )}
            </button>
          )}
          {!isExamMode && scenario.progress?.status !== 'not_started' && scenario.progress?.attempts > 0 && (
            <button
              className={styles.resetBtn}
              title="Reset progress for this scenario"
              onClick={async () => {
                const title = scenario.type === 'task'
                  ? 'Reset Scenario & Environment'
                  : 'Reset Scenario Progress'
                const message = scenario.type === 'task'
                  ? `Reset progress and cluster state for "${scenario.title}"?\n\nThis will run teardown to clean the environment.`
                  : `Reset progress for "${scenario.title}"?`
                const ok = await confirm({ title, message, confirmLabel: 'Reset', danger: true })
                if (!ok) return
                await resetProgress('scenario', { scenarioId: scenario.id })
                setSelectedOption(null)
                setMcqResult(null)
                setValidResult(null)
                setSetupState('idle')
                setHintsRevealed([])
                onProgressUpdate()
                if (scenario.type === 'task') {
                  await fetch(`/api/scenarios/${scenario.id}/teardown`, { method: 'POST' }).catch(() => {})
                }
              }}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 5, verticalAlign: 'middle' }}>
                <path d="M23 4v6h-6" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              Reset
            </button>
          )}
        </div>
        {(isCompleted && !isExamMode) && (
          <div className={styles.completedBanner}>
            <span>✓</span> Scenario completed
          </div>
        )}
        {isExamSubmitted && (
          <div className={styles.submittedBanner}>
            <span>✓</span> Submitted — results visible in exam report
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className={styles.tabs}>
        <div className={styles.tabsList}>
          {/* Problem tab */}
          <button
            className={`${styles.tab} ${tab === 'problem' ? styles.activeTab : ''}`}
            onClick={() => setTab('problem')}
          >
            📄 Problem
          </button>

          {/* Exam mode task submit — placed directly after Problem tab */}
          {isExamMode && scenario.type === 'task' && (
            <button
              className={isExamSubmitted ? styles.tabBarSubmittedBtn : styles.tabBarSubmitBtn}
              onClick={validate}
              disabled={validating || isExamSubmitted}
              title={isExamSubmitted ? 'Already submitted for this exam' : 'Submit this scenario'}
            >
              {validating ? (
                <><span className={styles.spinner} /> Submitting…</>
              ) : isExamSubmitted ? (
                <>
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Submitted
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                  Submit
                </>
              )}
            </button>
          )}

          {/* Practice mode: hints and validate tabs */}
          {!isExamMode && (
            <>
              <button
                className={`${styles.tab} ${tab === 'hints' ? styles.activeTab : ''}`}
                onClick={() => setTab('hints')}
              >
                💡 Hints ({scenario.hints?.length || 0})
              </button>
              {scenario.type === 'task' && (
                <button
                  className={`${styles.tab} ${tab === 'validate' ? styles.activeTab : ''}`}
                  onClick={() => setTab('validate')}
                >
                  ✓ Validate
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Tab content */}
      <div className={styles.content}>

        {/* PROBLEM TAB */}
        {tab === 'problem' && (
          <div className={styles.tabPane} style={{ animation: 'fadeIn 0.2s ease' }}>

            {/* Setup section (if setup commands exist) */}
            {scenario.setup_commands?.length > 0 && (
              <div className={styles.setupBox}>
                <div className={styles.setupHeader}>
                  <div className={styles.setupLabel}>
                    <span>⚡</span> Ready to start?
                  </div>
                  {setupState === 'idle' && (
                    <button className={styles.setupBtn} onClick={runSetup}>
                      ▶ Start Scenario
                    </button>
                  )}
                  {setupState === 'running' && (
                    <div className={styles.setupRunning}>
                      <span className={styles.spinner} />Setting up…
                    </div>
                  )}
                  {setupState === 'done' && (
                    <span className={styles.setupDone}>✓ Environment ready</span>
                  )}
                  {setupState === 'error' && (
                    <button className={styles.setupBtnRetry} onClick={runSetup}>⟳ Retry</button>
                  )}
                </div>
                <div className={styles.setupNote}>
                  Click <strong>Start Scenario</strong> to provision the lab environment, then solve the challenge below.
                </div>
              </div>
            )}

            {/* Problem description */}
            <div className="md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{scenario.description}</ReactMarkdown>
            </div>

            {/* MCQ options */}
            {scenario.type === 'mcq' && (
              <div className={styles.mcqSection}>
                <div className={styles.mcqLabel}>Select your answer:</div>
                <div className={styles.options}>
                  {scenario.options?.map(opt => {
                    const isSelected = selectedOption === opt.id
                    // In exam mode, never reveal which answer was correct/wrong while exam is active
                    const showCorrect = mcqResult && opt.id === mcqResult.correct_option && !isExamMode
                    const showWrong = mcqResult && isSelected && !mcqResult.correct && !isExamMode
                    return (
                      <button
                        key={opt.id}
                        className={`${styles.option}
                          ${isSelected ? styles.optionSelected : ''}
                          ${showCorrect ? styles.optionCorrect : ''}
                          ${showWrong ? styles.optionWrong : ''}
                        `}
                        onClick={() => !mcqResult && !isExamSubmitted && setSelectedOption(opt.id)}
                        disabled={!!mcqResult || isExamSubmitted}
                      >
                        <span className={styles.optionLetter}>{opt.id.toUpperCase()}</span>
                        <span className={styles.optionText}>
                          <InlineMd>{opt.text}</InlineMd>
                        </span>
                        {showCorrect && <span className={styles.optionMark}>✓</span>}
                        {showWrong && <span className={styles.optionMark}>✗</span>}
                      </button>
                    )
                  })}
                </div>

                {isExamSubmitted ? (
                  <div className={styles.examSubmittedInfo}>
                    ✓ Answer submitted — results will be visible in the exam report
                  </div>
                ) : !mcqResult ? (
                  <button
                    className={styles.submitBtn}
                    onClick={submitMCQ}
                    disabled={!selectedOption || submitting}
                  >
                    {submitting ? 'Submitting…' : isExamMode ? 'Submit Answer' : 'Submit Answer'}
                  </button>
                ) : !isExamMode ? (
                  <div className={`${styles.mcqResult} ${mcqResult.correct ? styles.mcqCorrect : styles.mcqWrong}`}>
                    <div className={styles.mcqResultTitle}>
                      {mcqResult.correct ? '✓ Correct!' : '✗ Incorrect — see the highlighted answer above'}
                    </div>
                    {mcqResult.explanation && (
                      <div className={styles.mcqExplanation}>
                        <InlineMd>{mcqResult.explanation}</InlineMd>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}

        {/* HINTS TAB */}
        {tab === 'hints' && (
          <div className={styles.tabPane} style={{ animation: 'fadeIn 0.2s ease' }}>
            {scenario.hints?.length === 0 && (
              <div className={styles.noHints}>No hints available for this scenario.</div>
            )}
            {scenario.hints?.map((hint, i) => {
              const revealed = hintsRevealed.includes(i)
              return (
                <div key={i} className={styles.hintCard}>
                  <div className={styles.hintHeader} onClick={() => setHintsRevealed(h => revealed ? h.filter(x => x !== i) : [...h, i])}>
                    <div className={styles.hintLeft}>
                      <span className={styles.hintNum}>Hint {i + 1}</span>
                      <span className={styles.hintTitle}>{hint.title}</span>
                    </div>
                    <span className={styles.hintChevron}>{revealed ? '▾' : '▸'}</span>
                  </div>
                  {revealed && (
                    <div className={styles.hintBody} style={{ animation: 'fadeIn 0.15s ease' }}>
                      <p className={styles.hintText}>
                        <InlineMd>{hint.body}</InlineMd>
                      </p>
                      {hint.command && (
                        <div className={styles.cmdBlock}>
                          <pre className={styles.cmdPre}>{hint.command}</pre>
                          <button
                            className={styles.copyBtn}
                            onClick={() => copyCmd(hint.command, i)}
                          >
                            {copiedCmd === i ? '✓ Copied' : 'Copy'}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* VALIDATE TAB — practice mode only */}
        {tab === 'validate' && scenario.type === 'task' && !isExamMode && (
          <div className={styles.tabPane} style={{ animation: 'fadeIn 0.2s ease' }}>
            <div className={styles.validateHeader}>
              <div className={styles.validateDesc}>
                {scenario.validation?.description}
              </div>
              <button
                className={styles.validateBtn}
                onClick={validate}
                disabled={validating}
              >
                {validating
                  ? <><span className={styles.spinner} /> Running checks…</>
                  : '▶ Run Validation'}
              </button>
            </div>

            {validResult && !validResult.error && (
              <div className={styles.checks}>
                <div className={`${styles.checksSummary} ${validResult.passed ? styles.allPassed : styles.someFailed}`}>
                  {validResult.passed
                    ? `✓ All ${validResult.checks.length} checks passed!`
                    : `${validResult.checks.filter(c => !c.passed).length} of ${validResult.checks.length} checks failed`}
                  <span className={styles.attempts}>Attempt #{validResult.attempts}</span>
                </div>
                {validResult.checks.map((c, i) => (
                  <div key={i} className={`${styles.check} ${c.passed ? styles.checkPass : styles.checkFail}`}>
                    <span className={styles.checkIcon}>{c.passed ? '✓' : '✗'}</span>
                    <div className={styles.checkContent}>
                      <div className={styles.checkDesc}>{c.description}</div>
                      {!c.passed && (
                        <div className={styles.checkDetail}>
                          <span>
                            {c.match === 'not_contains' ? 'Must not contain:' :
                             c.match === 'contains'     ? 'Must contain:'     :
                             c.match === 'regex'        ? 'Must match:'       :
                                                          'Expected:'}
                            {' '}<code>{c.expected}</code>
                          </span>
                          <span>Got: <code>{c.actual || '(empty)'}</code></span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {validResult?.error && (
              <div className={styles.validateError}>⚠ Validation failed to run. Is the cluster reachable?</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
