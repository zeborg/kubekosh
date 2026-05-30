const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const Database = require('better-sqlite3');

const app = express();
const PORT = 4000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend/dist')));

const SCENARIOS_FILE = path.join(__dirname, '../scenarios/scenarios.json');
const BUNDLES_FILE   = path.join(__dirname, '../scenarios/bundles.json');
const DB_FILE = process.env.PROGRESS_DB || '/data/progress.db';

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
  _db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      bundle_id     TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      submitted_at  TEXT,
      status        TEXT NOT NULL DEFAULT 'active',
      exam_minutes  INTEGER NOT NULL DEFAULT 120,
      duration_secs INTEGER,
      snapshot      TEXT
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
    }]));
  } catch { return {}; }
}

function saveProgress(progress) {
  try {
    const db = getDb();
    const upsert = db.prepare(`
      INSERT INTO progress (scenario_id, status, attempts, last_validated, completed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scenario_id) DO UPDATE SET
        status = excluded.status,
        attempts = excluded.attempts,
        last_validated = excluded.last_validated,
        completed_at = excluded.completed_at
    `);
    const tx = db.transaction((entries) => {
      for (const [id, p] of entries) {
        upsert.run(id, p.status, p.attempts || 0, p.last_validated || null, p.completed_at || null);
      }
    });
    tx(Object.entries(progress));
  } catch (e) {
    console.error('Failed to save progress:', e.message);
  }
}


function loadScenarios() {
  return JSON.parse(fs.readFileSync(SCENARIOS_FILE, 'utf8'));
}

function loadBundles() {
  return JSON.parse(fs.readFileSync(BUNDLES_FILE, 'utf8'));
}

function runCommand(cmd, timeoutMs = 15000) {
  try {
    const output = execSync(cmd, {
      timeout: timeoutMs,
      encoding: 'utf8',
      env: { ...process.env, KUBECONFIG: process.env.KUBECONFIG || '/root/.kube/config' }
    }).trim();
    return { success: true, output };
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
  const del = db.prepare('DELETE FROM progress WHERE scenario_id = ?');

  try {
    if (scope === 'scenario') {
      del.run(scenarioId);
    } else if (scope === 'category') {
      const scenarios = loadScenarios();
      const ids = scenarios.filter(s => s.category === category).map(s => s.id);
      const tx = db.transaction(ids => ids.forEach(id => del.run(id)));
      tx(ids);
    } else if (scope === 'bundle') {
      const bundle = loadBundles().find(b => b.id === bundleId);
      if (!bundle) return res.status(404).json({ error: 'Bundle not found' });
      const tx = db.transaction(ids => ids.forEach(id => del.run(id)));
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

// POST /api/sessions — start a new exam session
app.post('/api/sessions', (req, res) => {
  const { bundleId, examMinutes } = req.body;
  const bundle = loadBundles().find(b => b.id === bundleId);
  if (!bundle) return res.status(404).json({ error: 'Bundle not found' });
  const db = getDb();
  const mins = Math.max(5, Math.min(300, Number(examMinutes) || bundle.exam_minutes || 120));
  // Abandon any existing active session
  db.prepare(`UPDATE sessions SET status='abandoned', submitted_at=datetime('now')
              WHERE status='active'`).run();
  const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`INSERT INTO sessions (id, bundle_id, started_at, status, exam_minutes)
              VALUES (?, ?, datetime('now'), 'active', ?)`).run(id, bundleId, mins);
  res.json({ id, bundleId, status: 'active', exam_minutes: mins });
});

// GET /api/sessions/active — get the current active session
app.get('/api/sessions/active', (req, res) => {
  const db = getDb();
  const session = db.prepare(`SELECT * FROM sessions WHERE status='active' ORDER BY started_at DESC LIMIT 1`).get();
  if (!session) return res.json(null);
  const bundle = loadBundles().find(b => b.id === session.bundle_id);
  const progress = loadProgress();
  const scenarioIds = bundle?.scenario_ids || [];
  const completed = scenarioIds.filter(id => progress[id]?.status === 'completed').length;
  res.json({ ...session, scenarioCount: scenarioIds.length, completedCount: completed });
});

// POST /api/sessions/:id/submit — submit the exam session
app.post('/api/sessions/:id/submit', (req, res) => {
  const db = getDb();
  const session = db.prepare(`SELECT * FROM sessions WHERE id=?`).get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const bundle = loadBundles().find(b => b.id === session.bundle_id);
  const progress = loadProgress();
  const scenarios = loadScenarios();
  const bundleScenarios = scenarios.filter(s => bundle?.scenario_ids?.includes(s.id));
  const snapshot = bundleScenarios.map(s => ({
    id: s.id, title: s.title, weight: s.weight,
    category: s.category, type: s.type, difficulty: s.difficulty,
    status: progress[s.id]?.status || 'not_started',
    completed_at: progress[s.id]?.completed_at || null,
    attempts: progress[s.id]?.attempts || 0,
  }));
  const startedAt = new Date(session.started_at + 'Z');
  const durationSecs = Math.round((Date.now() - startedAt.getTime()) / 1000);
  db.prepare(`UPDATE sessions SET status='submitted', submitted_at=datetime('now'),
              duration_secs=?, snapshot=? WHERE id=?`)
    .run(durationSecs, JSON.stringify(snapshot), req.params.id);
  res.json({ ok: true, snapshot, durationSecs });
});

// POST /api/sessions/:id/abandon — forfeit the exam without a score report
app.post('/api/sessions/:id/abandon', (req, res) => {
  const db = getDb();
  const result = db.prepare(`UPDATE sessions SET status='abandoned', submitted_at=datetime('now')
                             WHERE id=? AND status='active'`).run(req.params.id);
  res.json({ ok: true, changed: result.changes });
});


// POST /api/scenarios/:id/teardown — run teardown_commands
app.post('/api/scenarios/:id/teardown', (req, res) => {
  const scenarios = loadScenarios();
  const scenario = scenarios.find(s => s.id === req.params.id);
  if (!scenario) return res.status(404).json({ error: 'Scenario not found' });
  const results = [];
  for (const item of (scenario.teardown_commands || [])) {
    const cmd = item.command;
    const result = runCommand(cmd, 30000);
    results.push({ command: cmd, ...result });
  }
  res.json({ ok: true, results });
});

// ── Context sync (Feature 3) ──────────────────────────────────────────────────

// POST /api/scenarios/:id/context — inject namespace + banner into active terminals
app.post('/api/scenarios/:id/context', (req, res) => {
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
  runCommand(`kubectl config set-context --current --namespace=${ns}`, 5000);

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

// GET /api/scenarios — list scenarios; optional ?bundle=<id> filter
app.get('/api/scenarios', (req, res) => {
  const scenarios = loadScenarios();
  const progress  = loadProgress();
  const { bundle } = req.query;

  let filtered = scenarios;
  if (bundle) {
    const bundles = loadBundles();
    const b = bundles.find(x => x.id === bundle);
    if (b) filtered = scenarios.filter(s => b.scenario_ids.includes(s.id));
  }

  const list = filtered.map(s => ({
    id: s.id,
    title: s.title,
    category: s.category,
    difficulty: s.difficulty,
    type: s.type,
    weight: s.weight,
    progress: progress[s.id] || { status: 'not_started', attempts: 0 }
  }));
  res.json(list);
});

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
app.post('/api/scenarios/:id/setup', (req, res) => {
  const scenarios = loadScenarios();
  const scenario = scenarios.find(s => s.id === req.params.id);
  if (!scenario) return res.status(404).json({ error: 'Scenario not found' });

  const results = [];
  for (const item of (scenario.setup_commands || [])) {
    const cmd = item.command;
    const result = runCommand(cmd, 30000);
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
app.post('/api/scenarios/:id/validate', (req, res) => {
  const scenarios = loadScenarios();
  const scenario = scenarios.find(s => s.id === req.params.id);
  if (!scenario) return res.status(404).json({ error: 'Scenario not found' });
  if (scenario.type !== 'task') return res.status(400).json({ error: 'Not a task scenario' });

  const checks = [];
  let allPassed = true;

  for (const check of (scenario.validation?.commands || [])) {
    const result = runCommand(check.command, 5000);
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
      actual,
      passed
    });
    if (!passed) allPassed = false;
  }

  // Update progress
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

  res.json({
    correct,
    correct_option: scenario.correct_option,
    explanation: scenario.explanation,
    attempts: progress[scenario.id].attempts
  });
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
  const progress = loadProgress();
  delete progress[req.params.id];
  saveProgress(progress);
  res.json({ ok: true });
});

// GET /api/health
app.get('/api/health', (req, res) => {
  const kube = runCommand('kubectl cluster-info --request-timeout=3s 2>&1 | head -1');
  res.json({ api: 'ok', cluster: kube.success ? 'ready' : 'not_ready', cluster_info: kube.output });
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

