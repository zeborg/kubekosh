const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const Database = require('better-sqlite3');
const { loadAddonManifests, validateGraph } = require('./lib/addons');
const { readState, writeState, reconcileInterrupted } = require('./lib/addon-state');
const { createJobEngine } = require('./lib/addon-jobs');
const { createAddonsRouter } = require('./routes/addons');

// Safety net: a single stray async error (e.g. a background addon job or health
// probe) must not silently kill the API and put the container in a restart loop.
// Log it loudly and keep serving — orchestrators read these lines.
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION (kept alive):', reason && reason.stack || reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION (kept alive):', err && err.stack || err);
});

const app = express();
const PORT = 4000;

app.use(express.json());
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    const originalJson = res.json;
    res.json = function(data) {
      if (!res.get('Content-Type')) {
        res.set('Content-Type', 'application/json');
      }
      return originalJson.call(this, data);
    };
  }
  next();
});
app.use(express.static(path.join(__dirname, '../frontend/dist')));

const SCENARIOS_DIR = path.join(__dirname, '../scenarios/data');
const BUNDLES_DIR   = path.join(__dirname, '../scenarios/bundles');
const DB_FILE = process.env.PROGRESS_DB || '/data/progress.db';

// ── Addons system paths (env-overridable for testability) ─────────────────────
// ADDONS_DIR        — addon manifests (addons/<id>/addon.json), shipped in-repo
// ADDONS_STATE_FILE — runtime install state, persisted on the /data mount
// ADDONS_BIN_DIR    — install target for target:"os" binaries; on /data so it
//                     survives container restarts and is added to the shell PATH
const ADDONS_DIR        = process.env.ADDONS_DIR        || path.join(__dirname, '../addons');
const ADDONS_STATE_FILE = process.env.ADDONS_STATE_FILE || '/data/addons-state.json';
const ADDONS_BIN_DIR    = process.env.ADDONS_BIN_DIR    || '/data/addons/bin';

// ── SQLite progress store ─────────────────────────────────────────────────────

let _db = null;
function getDb() {
  if (_db) return _db;
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(DB_FILE);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS progress (
      scenario_id   TEXT PRIMARY KEY,
      status        TEXT,
      attempts      INTEGER DEFAULT 0,
      last_validated TEXT,
      completed_at  TEXT
    )
  `);

  // Run dynamic schema migrations to add missing columns to the progress table
  try {
    const tableInfo = _db.prepare("PRAGMA table_info(progress)").all();
    const existingColumns = tableInfo.map(col => col.name);
    
    const requiredColumns = [
      { name: 'started_at', type: 'TEXT' },
      { name: 'notes', type: 'TEXT' },
      { name: 'time_spent_seconds', type: 'INTEGER' }
    ];
    
    for (const col of requiredColumns) {
      if (!existingColumns.includes(col.name)) {
        console.log(`Migrating progress database schema: Adding column '${col.name}' (${col.type})`);
        _db.exec(`ALTER TABLE progress ADD COLUMN ${col.name} ${col.type}`);
      }
    }
  } catch (e) {
    console.error('Failed to run schema migrations on progress table:', e.message);
  }

  _db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      bundle_id     TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      submitted_at  TEXT,
      status        TEXT NOT NULL DEFAULT 'active',
      exam_minutes  INTEGER NOT NULL DEFAULT 120,
      duration_secs INTEGER,
      snapshot      TEXT,
      scenario_ids  TEXT
    )
  `);

  // Migrate: add scenario_ids column if missing
  try {
    const cols = _db.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
    if (!cols.includes('scenario_ids')) {
      _db.exec(`ALTER TABLE sessions ADD COLUMN scenario_ids TEXT`);
    }
  } catch (e) {
    console.error('Failed to migrate sessions table:', e.message);
  }

  // Separate exam-session progress table — tracks completions per session
  _db.exec(`
    CREATE TABLE IF NOT EXISTS exam_progress (
      session_id    TEXT NOT NULL,
      scenario_id   TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'in_progress',
      attempts      INTEGER NOT NULL DEFAULT 0,
      completed_at  TEXT,
      PRIMARY KEY (session_id, scenario_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);
  return _db;
}

function loadProgress() {
  try {
    const rows = getDb().prepare('SELECT * FROM progress').all();
    return Object.fromEntries(rows.map(r => [r.scenario_id, {
      status: r.status,
      attempts: r.attempts,
      last_validated: r.last_validated,
      completed_at: r.completed_at,
      started_at: r.started_at || null,
      notes: r.notes || null,
      time_spent_seconds: r.time_spent_seconds || 0
    }]));
  } catch { return {}; }
}

function saveProgress(progress) {
  try {
    const db = getDb();
    const upsert = db.prepare(`
      INSERT INTO progress (scenario_id, status, attempts, last_validated, completed_at, started_at, notes, time_spent_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scenario_id) DO UPDATE SET
        status = excluded.status,
        attempts = excluded.attempts,
        last_validated = excluded.last_validated,
        completed_at = excluded.completed_at,
        started_at = excluded.started_at,
        notes = excluded.notes,
        time_spent_seconds = excluded.time_spent_seconds
    `);
    const tx = db.transaction((entries) => {
      for (const [id, p] of entries) {
        upsert.run(
          id,
          p.status || null,
          p.attempts || 0,
          p.last_validated || null,
          p.completed_at || null,
          p.started_at || null,
          p.notes || null,
          p.time_spent_seconds || 0
        );
      }
    });
    tx(Object.entries(progress));
  } catch (e) {
    console.error('Failed to save progress:', e.message);
  }
}


function loadJsonDir(dir) {
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

let scenariosCache = [];
let bundlesCache = [];
let addonsCache = [];

function reloadCache() {
  try {
    scenariosCache = loadJsonDir(SCENARIOS_DIR);
    bundlesCache = loadJsonDir(BUNDLES_DIR);

    const { addons, errors } = loadAddonManifests(ADDONS_DIR);
    addonsCache = addons;
    errors.forEach(e => console.warn(`Addon manifest issue: ${e}`));
    validateGraph(addonsCache).forEach(e => console.warn(`Addon dependency issue: ${e}`));

    console.log(`Loaded ${scenariosCache.length} scenarios, ${bundlesCache.length} bundles, and ${addonsCache.length} addons into cache.`);
  } catch (e) {
    console.error('Failed to reload cache:', e.message);
  }
}

// Initial cache populate
reloadCache();

// Addons: repair any jobs left mid-flight by a previous container run
try {
  const state = readState(ADDONS_STATE_FILE);
  const reconciled = reconcileInterrupted(state);
  if (JSON.stringify(reconciled) !== JSON.stringify(state)) {
    writeState(ADDONS_STATE_FILE, reconciled);
    console.log('Reconciled interrupted addon jobs from a previous run.');
  }
} catch (e) {
  console.error('Addon state reconciliation failed:', e.message);
}

function loadScenarios() {
  return scenariosCache;
}

function loadBundles() {
  return bundlesCache;
}

function loadAddons() {
  return addonsCache;
}

async function runCommand(cmd, timeoutMs = 15000) {
  try {
    const { stdout } = await execAsync(cmd, {
      timeout: timeoutMs,
      encoding: 'utf8',
      env: { ...process.env, KUBECONFIG: process.env.KUBECONFIG || '/root/.kube/config' }
    });
    return { success: true, output: stdout.trim() };
  } catch (e) {
    return { success: false, output: (e.stdout || '').trim(), error: (e.stderr || e.message || '').trim() };
  }
}

function checkMatch(actual, expected, matchType) {
  const a = String(actual).trim();
  const e = String(expected).trim();
  if (matchType === 'exact') return a === e;
  if (matchType === 'contains') return a.includes(e);
  if (matchType === 'not_contains') return !a.includes(e);
  if (matchType === 'regex') return new RegExp(e).test(a);
  return a === e;
}

// Active WebSocket terminal clients — write output directly (NOT as shell input)
const activeWsClients = new Set()
// Active PTY shells — used only to write '\r' and trigger PS1 prompt repaint
const activeShells = new Set()

// Inject text directly into all terminals as output (never touches shell stdin)
function injectToTerminal(text) {
  for (const ws of activeWsClients) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(text)
    } catch (_) {}
  }
}

// Write a carriage-return to every active shell so bash repaints its PS1 prompt
function refreshPrompt(delayMs = 80) {
  setTimeout(() => {
    for (const shell of activeShells) {
      try { shell.write('\r') } catch (_) {}
    }
  }, delayMs)
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/progress/reset — reset progress for scenario | category | bundle
app.post('/api/progress/reset', (req, res) => {
  const { scope, scenarioId, category, bundleId } = req.body;
  const db = getDb();
  const resetProgressStmt = db.prepare(`
    UPDATE progress 
    SET status = 'not_started', 
        attempts = 0, 
        completed_at = NULL, 
        last_validated = NULL 
    WHERE scenario_id = ?
  `);

  try {
    if (scope === 'scenario') {
      resetProgressStmt.run(scenarioId);
    } else if (scope === 'category') {
      const scenarios = loadScenarios();
      const ids = scenarios.filter(s => s.category === category).map(s => s.id);
      const tx = db.transaction(ids => ids.forEach(id => resetProgressStmt.run(id)));
      tx(ids);
    } else if (scope === 'bundle') {
      const bundle = loadBundles().find(b => b.id === bundleId);
      if (!bundle) return res.status(404).json({ error: 'Bundle not found' });
      const tx = db.transaction(ids => ids.forEach(id => resetProgressStmt.run(id)));
      tx(bundle.scenario_ids);
    } else {
      return res.status(400).json({ error: 'Invalid scope' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Exam sessions ─────────────────────────────────────────────────────────────

// Fisher-Yates shuffle (returns a new array)
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// POST /api/sessions — start a new exam session
app.post('/api/sessions', (req, res) => {
  const { bundleId, examMinutes, scenarioCount } = req.body;
  const bundle = loadBundles().find(b => b.id === bundleId);
  if (!bundle) return res.status(404).json({ error: 'Bundle not found' });
  const db = getDb();
  const mins = Math.max(5, Math.min(300, Number(examMinutes) || bundle.exam_minutes || 120));
  // Shuffle and optionally slice scenario IDs
  const allIds = bundle.scenario_ids || [];
  const count = Math.max(1, Math.min(allIds.length, Number(scenarioCount) || allIds.length));
  const sessionScenarioIds = shuffle(allIds).slice(0, count);
  // Abandon any existing active session
  db.prepare(`UPDATE sessions SET status='abandoned', submitted_at=datetime('now')
              WHERE status='active'`).run();
  const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`INSERT INTO sessions (id, bundle_id, started_at, status, exam_minutes, scenario_ids)
              VALUES (?, ?, datetime('now'), 'active', ?, ?)`)
    .run(id, bundleId, mins, JSON.stringify(sessionScenarioIds));
  res.json({ id, bundleId, status: 'active', exam_minutes: mins, scenario_ids: sessionScenarioIds });
});

// GET /api/sessions/active — get the current active session
app.get('/api/sessions/active', (req, res) => {
  const db = getDb();
  const session = db.prepare(`SELECT * FROM sessions WHERE status='active' ORDER BY started_at DESC LIMIT 1`).get();
  if (!session) return res.json(null);
  // Use session-specific scenario_ids (shuffled/sliced at start time)
  let scenarioIds = [];
  try { scenarioIds = session.scenario_ids ? JSON.parse(session.scenario_ids) : []; } catch (_) {}
  if (!scenarioIds.length) {
    // Fallback for sessions created before this feature
    const bundle = loadBundles().find(b => b.id === session.bundle_id);
    scenarioIds = bundle?.scenario_ids || [];
  }
  const completed = db.prepare(
    `SELECT COUNT(*) as cnt FROM exam_progress WHERE session_id=? AND status='completed'`
  ).get(session.id)?.cnt || 0;
  res.json({ ...session, scenario_ids: scenarioIds, scenarioCount: scenarioIds.length, completedCount: completed });
});

// GET /api/sessions/:id/exam-progress — return per-scenario progress for an exam session
app.get('/api/sessions/:id/exam-progress', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM exam_progress WHERE session_id=?`).all(req.params.id);
  // Return as a map: scenario_id -> { status, attempts, completed_at }
  const result = {};
  for (const r of rows) {
    result[r.scenario_id] = { status: r.status, attempts: r.attempts, completed_at: r.completed_at };
  }
  res.json(result);
});

// GET /api/sessions/history — list all completed/abandoned exam sessions (newest first)
app.get('/api/sessions/history', (req, res) => {
  const db = getDb();
  const sessions = db.prepare(
    `SELECT * FROM sessions WHERE status != 'active' ORDER BY started_at DESC`
  ).all();
  const bundles = loadBundles();

  const result = sessions.map(s => {
    const bundle = bundles.find(b => b.id === s.bundle_id);
    let snapshot = [];
    try { snapshot = s.snapshot ? JSON.parse(s.snapshot) : []; } catch (_) {}
    const completed = snapshot.filter(x => x.status === 'completed');
    const totalWeight = snapshot.reduce((a, x) => a + (x.weight || 0), 0);
    const earnedWeight = completed.reduce((a, x) => a + (x.weight || 0), 0);
    const pct = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0;
    return {
      id: s.id,
      bundle_id: s.bundle_id,
      bundle_name: bundle?.name || s.bundle_id,
      bundle_icon: bundle?.icon || '🎓',
      status: s.status,
      started_at: s.started_at,
      submitted_at: s.submitted_at,
      exam_minutes: s.exam_minutes,
      duration_secs: s.duration_secs,
      scenarioCount: snapshot.length,
      completedCount: completed.length,
      totalWeight,
      earnedWeight,
      pct,
      passed: pct >= 66,
      snapshot,
    };
  });

  res.json(result);
});

// POST /api/sessions/:id/submit — submit the exam session
app.post('/api/sessions/:id/submit', (req, res) => {
  const db = getDb();
  const session = db.prepare(`SELECT * FROM sessions WHERE id=?`).get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const bundle = loadBundles().find(b => b.id === session.bundle_id);
  const scenarios = loadScenarios();
  // Use session-specific scenario IDs (preserves shuffle order)
  let sessionIds = [];
  try { sessionIds = session.scenario_ids ? JSON.parse(session.scenario_ids) : []; } catch (_) {}
  if (!sessionIds.length) sessionIds = bundle?.scenario_ids || [];
  const bundleScenarios = sessionIds.map(id => scenarios.find(s => s.id === id)).filter(Boolean);

  // Build snapshot from exam_progress (exam-specific), falling back to 'not_started'
  const examProgressRows = db.prepare(`SELECT * FROM exam_progress WHERE session_id=?`).all(req.params.id);
  const examProgressMap = {};
  for (const r of examProgressRows) examProgressMap[r.scenario_id] = r;

  // Also pull time_spent_seconds from global progress (tracked per scenario during the exam)
  const globalProgress = loadProgress();

  const snapshot = bundleScenarios.map(s => ({
    id: s.id, title: s.title, weight: s.weight,
    category: s.category, type: s.type, difficulty: s.difficulty,
    status: examProgressMap[s.id]?.status || 'not_started',
    completed_at: examProgressMap[s.id]?.completed_at || null,
    attempts: examProgressMap[s.id]?.attempts || 0,
    time_spent_seconds: globalProgress[s.id]?.time_spent_seconds || 0,
  }));
  const startedAt = new Date(session.started_at + 'Z');
  const durationSecs = Math.round((Date.now() - startedAt.getTime()) / 1000);
  db.prepare(`UPDATE sessions SET status='submitted', submitted_at=datetime('now'),
              duration_secs=?, snapshot=? WHERE id=?`)
    .run(durationSecs, JSON.stringify(snapshot), req.params.id);

  // Reset timers of all scenarios in this bundle
  const clearTimer = db.prepare(`UPDATE progress SET started_at = NULL, time_spent_seconds = 0 WHERE scenario_id = ?`);
  const tx = db.transaction(ids => ids.forEach(id => clearTimer.run(id)));
  tx(bundle.scenario_ids);

  res.json({ ok: true, snapshot, durationSecs });
});

// POST /api/sessions/:id/abandon — forfeit the exam without a score report
app.post('/api/sessions/:id/abandon', (req, res) => {
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const bundles = loadBundles();
  const bundle = bundles.find(b => b.id === session.bundle_id);

  db.prepare(`UPDATE sessions SET status='abandoned', submitted_at=datetime('now')
                             WHERE id=? AND status='active'`).run(req.params.id);

  if (bundle) {
    const clearTimer = db.prepare(`UPDATE progress SET started_at = NULL, time_spent_seconds = 0 WHERE scenario_id = ?`);
    const tx = db.transaction(ids => ids.forEach(id => clearTimer.run(id)));
    tx(bundle.scenario_ids);
  }

  res.json({ ok: true });
});


// POST /api/scenarios/:id/teardown — run teardown_commands
app.post('/api/scenarios/:id/teardown', async (req, res) => {
  const scenarios = loadScenarios();
  const scenario = scenarios.find(s => s.id === req.params.id);
  if (!scenario) return res.status(404).json({ error: 'Scenario not found' });
  const results = [];
  for (const item of (scenario.teardown_commands || [])) {
    const cmd = item.command;
    const result = await runCommand(cmd, 30000);
    results.push({ command: cmd, ...result });
  }
  res.json({ ok: true, results });
});

// ── Context sync (Feature 3) ──────────────────────────────────────────────────

// POST /api/scenarios/:id/context — inject namespace + banner into active terminals
app.post('/api/scenarios/:id/context', async (req, res) => {
  const scenarios = loadScenarios();
  const scenario = scenarios.find(s => s.id === req.params.id);
  if (!scenario) return res.status(404).json({ error: 'Scenario not found' });
  const ns = scenario.default_namespace || 'default';

  // VT sequences: clear visible screen + scrollback, then move cursor to top-left
  const clearScreen = '\x1b[2J\x1b[3J\x1b[H';
  const line = '\u2500'.repeat(54);
  const banner = [
    `\x1b[2m# ${line}\x1b[0m\r\n`,
    `\x1b[1m\x1b[36m\u2388  Scenario : \x1b[0m\x1b[1m\x1b[97m${scenario.title}\x1b[0m\r\n`,
    `\x1b[2m   Namespace: \x1b[0m\x1b[33m${ns}\x1b[0m`,
    `  \x1b[2mDifficulty: \x1b[0m${scenario.difficulty === 'Easy' ? '\x1b[32m' : scenario.difficulty === 'Hard' ? '\x1b[31m' : '\x1b[33m'}${scenario.difficulty}\x1b[0m\r\n`,
    `\x1b[2m# ${line}\x1b[0m\r\n`,
  ].join('');

  // Set kubectl context namespace silently
  await runCommand(`kubectl config set-context --current --namespace=${ns}`, 5000);

  // 1) Clear screen and write banner as terminal output (never touches shell stdin)
  injectToTerminal(clearScreen + banner);

  // 2) After banner renders, write \r to each PTY so bash repaints its PS1 prompt
  refreshPrompt(80);

  res.json({ ok: true, namespace: ns });
});

// GET /api/bundles — list bundles with per-bundle progress stats
app.get('/api/bundles', (req, res) => {
  const bundles   = loadBundles();
  const scenarios = loadScenarios();
  const progress  = loadProgress();
  const result = bundles.map(b => {
    const total     = b.scenario_ids.length;
    const completed = b.scenario_ids.filter(id => progress[id]?.status === 'completed').length;
    return { ...b, stats: { total, completed } };
  });
  res.json(result);
});

// GET /api/scenarios — list scenarios; optional ?bundle=<id> and ?session=<id> filter
app.get('/api/scenarios', (req, res) => {
  const scenarios = loadScenarios()
  const progress  = loadProgress()
  const { bundle, session: sessionId } = req.query

  // Session-scoped: return only session scenario_ids in their shuffled order
  if (sessionId) {
    const db = getDb()
    const session = db.prepare(`SELECT scenario_ids FROM sessions WHERE id=?`).get(sessionId)
    let sessionIds = []
    try { sessionIds = session?.scenario_ids ? JSON.parse(session.scenario_ids) : [] } catch (_) {}
    const list = sessionIds
      .map(id => scenarios.find(s => s.id === id))
      .filter(Boolean)
      .map(s => ({
        id: s.id, title: s.title, category: s.category,
        difficulty: s.difficulty, type: s.type, weight: s.weight,
        progress: progress[s.id] || { status: 'not_started', attempts: 0 }
      }))
    return res.json(list)
  }

  let filtered = scenarios
  if (bundle) {
    const bundles = loadBundles()
    const b = bundles.find(x => x.id === bundle)
    if (b) filtered = scenarios.filter(s => b.scenario_ids.includes(s.id))
  }

  const list = filtered.map(s => ({
    id: s.id,
    title: s.title,
    category: s.category,
    difficulty: s.difficulty,
    type: s.type,
    weight: s.weight,
    progress: progress[s.id] || { status: 'not_started', attempts: 0 }
  }))
  res.json(list)
})

// GET /api/scenarios/:id — full scenario detail
app.get('/api/scenarios/:id', (req, res) => {
  const scenarios = loadScenarios();
  const scenario = scenarios.find(s => s.id === req.params.id);
  if (!scenario) return res.status(404).json({ error: 'Scenario not found' });
  const progress = loadProgress();
  res.json({
    ...scenario,
    progress: progress[scenario.id] || { status: 'not_started', attempts: 0 }
  });
});

// POST /api/scenarios/:id/setup — run setup_commands for a scenario
app.post('/api/scenarios/:id/setup', async (req, res) => {
  const scenarios = loadScenarios();
  const scenario = scenarios.find(s => s.id === req.params.id);
  if (!scenario) return res.status(404).json({ error: 'Scenario not found' });

  const results = [];
  for (const item of (scenario.setup_commands || [])) {
    const cmd = item.command;
    const result = await runCommand(cmd, 30000);
    results.push({ command: cmd, ...result });
    if (!result.success) {
      // Non-fatal: setup commands like "kubectl create namespace" fail if already exists
      console.warn(`Setup command warning: ${cmd} -> ${result.error}`);
    }
  }

  // Mark scenario as in-progress
  const progress = loadProgress();
  if (!progress[scenario.id] || progress[scenario.id].status === 'not_started') {
    progress[scenario.id] = {
      ...progress[scenario.id],
      status: 'in_progress',
      attempts: (progress[scenario.id]?.attempts || 0),
      started_at: progress[scenario.id]?.started_at || new Date().toISOString()
    };
    saveProgress(progress);
  }

  res.json({ setup_results: results });
});

// POST /api/scenarios/:id/validate — validate task-based scenario
app.post('/api/scenarios/:id/validate', async (req, res) => {
  const scenarios = loadScenarios();
  const scenario = scenarios.find(s => s.id === req.params.id);
  if (!scenario) return res.status(404).json({ error: 'Scenario not found' });
  if (scenario.type !== 'task') return res.status(400).json({ error: 'Not a task scenario' });

  const checks = [];
  let allPassed = true;

  for (const check of (scenario.validation?.commands || [])) {
    const result = await runCommand(check.command, 5000);
    // Prefer stdout. Only fall back to stderr for non-API errors:
    // - kubectl auth can-i prints "yes"/"no" to stdout → already in result.output.
    // - kubectl get <missing-resource> prints "Error from server (NotFound):" to stderr
    //   and nothing to stdout → suppress, return '' so the check fails cleanly.
    const isKubectlApiError = result.error &&
      /^Error from server|^error:|^Error:/i.test(result.error.trim());
    const actual = result.output || (isKubectlApiError ? '' : result.error) || '';
    const passed = checkMatch(actual, check.expected_output, check.match);

    checks.push({
      description: check.description,
      command: check.command,
      expected: check.expected_output,
      match: check.match || 'exact',
      actual,
      passed
    });
    if (!passed) allPassed = false;
  }

  // Update global practice progress
  const progress = loadProgress();
  const prev = progress[scenario.id] || { attempts: 0 };
  progress[scenario.id] = {
    ...prev,
    status: allPassed ? 'completed' : 'in_progress',
    attempts: (prev.attempts || 0) + 1,
    last_validated: new Date().toISOString(),
    completed_at: allPassed ? new Date().toISOString() : prev.completed_at
  };
  saveProgress(progress);

  // Also update exam_progress if there's an active session
  const db = getDb();
  const activeSession = db.prepare(`SELECT id FROM sessions WHERE status='active' LIMIT 1`).get();
  if (activeSession) {
    const ep = db.prepare(`SELECT * FROM exam_progress WHERE session_id=? AND scenario_id=?`)
      .get(activeSession.id, scenario.id);
    const epAttempts = (ep?.attempts || 0) + 1;
    db.prepare(`
      INSERT INTO exam_progress (session_id, scenario_id, status, attempts, completed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, scenario_id) DO UPDATE SET
        status = excluded.status,
        attempts = excluded.attempts,
        completed_at = COALESCE(excluded.completed_at, exam_progress.completed_at)
    `).run(
      activeSession.id, scenario.id,
      allPassed ? 'completed' : 'in_progress',
      epAttempts,
      allPassed ? new Date().toISOString() : null
    );
  }

  res.json({ passed: allPassed, checks, attempts: progress[scenario.id].attempts });
});

// POST /api/scenarios/:id/answer — submit MCQ answer
app.post('/api/scenarios/:id/answer', (req, res) => {
  const { selected } = req.body;
  const scenarios = loadScenarios();
  const scenario = scenarios.find(s => s.id === req.params.id);
  if (!scenario) return res.status(404).json({ error: 'Scenario not found' });
  if (scenario.type !== 'mcq') return res.status(400).json({ error: 'Not an MCQ scenario' });

  const correct = selected === scenario.correct_option;

  // Update global practice progress
  const progress = loadProgress();
  const prev = progress[scenario.id] || { attempts: 0 };
  progress[scenario.id] = {
    ...prev,
    status: correct ? 'completed' : 'in_progress',
    attempts: (prev.attempts || 0) + 1,
    last_answer: selected,
    last_validated: new Date().toISOString(),
    completed_at: correct ? new Date().toISOString() : prev.completed_at
  };
  saveProgress(progress);

  // Also update exam_progress if there's an active session
  const db = getDb();
  const activeSession = db.prepare(`SELECT id FROM sessions WHERE status='active' LIMIT 1`).get();
  if (activeSession) {
    const ep = db.prepare(`SELECT * FROM exam_progress WHERE session_id=? AND scenario_id=?`)
      .get(activeSession.id, scenario.id);
    const epAttempts = (ep?.attempts || 0) + 1;
    db.prepare(`
      INSERT INTO exam_progress (session_id, scenario_id, status, attempts, completed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, scenario_id) DO UPDATE SET
        status = excluded.status,
        attempts = excluded.attempts,
        completed_at = COALESCE(excluded.completed_at, exam_progress.completed_at)
    `).run(
      activeSession.id, scenario.id,
      correct ? 'completed' : 'in_progress',
      epAttempts,
      correct ? new Date().toISOString() : null
    );
  }

  res.json({
    correct,
    correct_option: scenario.correct_option,
    explanation: scenario.explanation,
    attempts: progress[scenario.id].attempts
  });
});

// POST /api/scenarios/:id/time — update time spent on a scenario
app.post('/api/scenarios/:id/time', (req, res) => {
  const { time_spent_seconds } = req.body;
  if (typeof time_spent_seconds !== 'number') {
    return res.status(400).json({ error: 'Invalid time_spent_seconds' });
  }
  const db = getDb();
  const activeSession = db.prepare("SELECT 1 FROM sessions WHERE status='active'").get();
  if (!activeSession) {
    return res.json({ ok: true, message: 'No active session' });
  }
  const progress = loadProgress();
  if (!progress[req.params.id]) {
    progress[req.params.id] = {
      status: 'in_progress',
      attempts: 0,
      started_at: new Date().toISOString(),
      time_spent_seconds: 0
    };
  } else if (!progress[req.params.id].started_at) {
    progress[req.params.id].started_at = new Date().toISOString();
  }
  progress[req.params.id].time_spent_seconds = time_spent_seconds;
  saveProgress(progress);
  res.json({ ok: true });
});

// GET /api/progress — full progress summary
app.get('/api/progress', (req, res) => {
  const scenarios = loadScenarios();
  const progress = loadProgress();
  const total = scenarios.length;
  const completed = Object.values(progress).filter(p => p.status === 'completed').length;
  const totalWeight = scenarios.reduce((sum, s) => sum + (s.weight || 0), 0);
  const earnedWeight = scenarios
    .filter(s => progress[s.id]?.status === 'completed')
    .reduce((sum, s) => sum + (s.weight || 0), 0);
  res.json({
    total, completed,
    score_pct: totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0,
    details: progress
  });
});

// POST /api/progress/reset/:id — reset a scenario
app.post('/api/progress/reset/:id', (req, res) => {
  try {
    const db = getDb();
    db.prepare(`
      UPDATE progress 
      SET status = 'not_started', 
          attempts = 0, 
          completed_at = NULL, 
          last_validated = NULL 
      WHERE scenario_id = ?
    `).run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/cache/reload — reload scenarios and bundles cache
app.post('/api/cache/reload', (req, res) => {
  reloadCache();
  res.json({
    ok: true,
    message: 'Cache reloaded successfully',
    scenarios_count: loadScenarios().length,
    bundles_count: loadBundles().length,
    addons_count: loadAddons().length
  });
});

// Addons API — async install/remove engine + SSE streaming
const addonEngine = createJobEngine({
  loadAddons,
  stateFile: ADDONS_STATE_FILE,
  binDir: ADDONS_BIN_DIR
});
app.use('/api/addons', createAddonsRouter({ loadAddons, stateFile: ADDONS_STATE_FILE, engine: addonEngine }));

// Best-effort: re-install addons whose health check fails after a restart
// (e.g. OS binaries lost on an ephemeral filesystem). Non-blocking.
addonEngine.healthReconcile().catch(e => console.error('addon health reconcile failed:', e.message));

// GET /api/health
app.get('/api/health', async (req, res) => {
  const kube = await runCommand('kubectl cluster-info --request-timeout=3s 2>&1 | head -1');
  res.type('application/json').json({ api: 'ok', cluster: kube.success ? 'ready' : 'not_ready', cluster_info: kube.output });
});

// Fallback to frontend SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

// ── WebSocket PTY terminal ────────────────────────────────────────────────────
const http = require('http');
const WebSocket = require('ws');
const pty = require('node-pty');

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws) => {
  activeWsClients.add(ws);

  const shell = pty.spawn('/bin/bash', [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: '/root',
    env: {
      ...process.env,
      KUBECONFIG: '/root/.kube/config',
      HOME: '/root',
      TERM: 'xterm-256color',
    },
  });

  activeShells.add(shell);

  // Forward PTY output → browser
  shell.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });

  shell.onExit(() => {
    activeWsClients.delete(ws);
    activeShells.delete(shell);
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });

  // Forward browser input → PTY
  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === 'resize') {
        shell.resize(Number(parsed.cols) || 80, Number(parsed.rows) || 24);
        return;
      }
    } catch (_) { /* not JSON → raw input */ }
    shell.write(typeof msg === 'string' ? msg : msg.toString());
  });

  ws.on('close', () => { activeWsClients.delete(ws); activeShells.delete(shell); try { shell.kill(); } catch (_) {} });
  ws.on('error', () => { activeWsClients.delete(ws); activeShells.delete(shell); try { shell.kill(); } catch (_) {} });
});

// Handle WebSocket upgrades only for /shell-ws
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/shell-ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => console.log(`API server running on :${PORT}`));

