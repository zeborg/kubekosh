import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import styles from './ScenarioPanel.module.css'

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

export default function ScenarioPanel({ scenario, onProgressUpdate, onScenarioStart, isExamMode }) {
  const [tab, setTab] = useState('problem')
  const [setupState, setSetupState] = useState('idle') // idle | running | done | error
  const [validating, setValidating] = useState(false)
  const [validResult, setValidResult] = useState(null)
  const [selectedOption, setSelectedOption] = useState(null)
  const [mcqResult, setMcqResult] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [hintsRevealed, setHintsRevealed] = useState([])
  const [copiedCmd, setCopiedCmd] = useState(null)

  // Reset state when scenario changes
  useEffect(() => {
    setTab('problem')
    setSetupState('idle')
    setValidResult(null)
    setSelectedOption(null)
    setMcqResult(null)
    setHintsRevealed([])
  }, [scenario?.id])

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
    setValidating(true)
    setValidResult(null)
    try {
      const r = await fetch(`/api/scenarios/${scenario.id}/validate`, { method: 'POST' })
      const d = await r.json()
      setValidResult(d)
      onProgressUpdate()
    } catch {
      setValidResult({ error: true })
    }
    setValidating(false)
  }

  async function submitMCQ() {
    if (!selectedOption) return
    setSubmitting(true)
    try {
      const r = await fetch(`/api/scenarios/${scenario.id}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected: selectedOption })
      })
      const d = await r.json()
      setMcqResult(d)
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

  return (
    <div className={styles.panel}>
      {/* Scenario header */}
      <div className={styles.scenarioHeader}>
        <div className={styles.scenarioMeta}>
          <span className={styles.category}>{scenario.category}</span>
          <span className={`${styles.diff} ${styles[scenario.difficulty?.toLowerCase()]}`}>
            {scenario.difficulty}
          </span>
          <span className={styles.typeTag}>{scenario.type === 'mcq' ? 'Multiple Choice' : 'Hands-on Task'}</span>
          <span className={styles.weight}>{scenario.weight} pts</span>
        </div>
        <div className={styles.titleRow}>
          <div className={styles.scenarioTitle}>{scenario.title}</div>
          {scenario.progress?.status !== 'not_started' && scenario.progress?.attempts > 0 && (
            <button
              className={styles.resetBtn}
              title="Reset progress for this scenario"
              onClick={async () => {
                if (!window.confirm(`Reset progress for "${scenario.title}"?`)) return
                await resetProgress('scenario', { scenarioId: scenario.id })
                setSelectedOption(null)
                setMcqResult(null)
                setValidResult(null)
                setSetupState('idle')
                setHintsRevealed([])
                onProgressUpdate()
              }}
            >
              ↺ Reset
            </button>
          )}
        </div>
        {isCompleted && (
          <div className={styles.completedBanner}>
            <span>✓</span> Scenario completed
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className={styles.tabs}>
        {['problem', ...(isExamMode ? [] : ['hints']), ...(scenario.type === 'task' && !isExamMode ? ['validate'] : [])].map(t => (
          <button
            key={t}
            className={`${styles.tab} ${tab === t ? styles.activeTab : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'problem' ? '📄 Problem'
              : t === 'hints' ? `💡 Hints (${scenario.hints?.length || 0})`
              : '✓ Validate'}
          </button>
        ))}
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
                    const showCorrect = mcqResult && opt.id === mcqResult.correct_option
                    const showWrong = mcqResult && isSelected && !mcqResult.correct
                    return (
                      <button
                        key={opt.id}
                        className={`${styles.option}
                          ${isSelected ? styles.optionSelected : ''}
                          ${showCorrect ? styles.optionCorrect : ''}
                          ${showWrong ? styles.optionWrong : ''}
                        `}
                        onClick={() => !mcqResult && setSelectedOption(opt.id)}
                        disabled={!!mcqResult}
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

                {!mcqResult ? (
                  <button
                    className={styles.submitBtn}
                    onClick={submitMCQ}
                    disabled={!selectedOption || submitting}
                  >
                    {submitting ? 'Checking…' : 'Submit Answer'}
                  </button>
                ) : (
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
                )}
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

        {/* VALIDATE TAB */}
        {tab === 'validate' && scenario.type === 'task' && (
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
                          <span>Expected: <code>{c.expected}</code></span>
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
