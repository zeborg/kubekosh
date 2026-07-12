'use strict';

const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const { exec }  = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const Database  = require('better-sqlite3');

const { readState, writeState, reconcileInterrupted } = require('./lib/addon-state');
const { createJobEngine }  = require('./lib/addon-jobs');
const { reloadCache, loadAddons } = require('./lib/cache');

const { createAddonsRouter }   = require('./routes/addons');
const { createTracksRouter }   = require('./routes/tracks');
const { createBundlesRouter }  = require('./routes/bundles');
const { createScenariosRouter } = require('./routes/scenarios');
const { createProgressRouter } = require('./routes/progress');
const { createSessionsRouter } = require('./routes/sessions');
const { createCacheRouter }    = require('./routes/cache');
const { createHealthRouter }   = require('./routes/health');

// Safety net: a single stray async error (e.g. a background addon job or health
// probe) must not silently kill the API and put the container in a restart loop.
// Log it loudly and keep serving — orchestrators read these lines.
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION (kept alive):', reason && reason.stack || reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION (kept alive):', err && err.stack || err);
});

const app  = express();
const PORT = 4000;

app.use(express.json());
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    const originalJson = res.json;
    res.json = function(data) {
      if (!res.get('Content-Type')) res.set('Content-Type', 'application/json');
      return originalJson.call(this, data);
    };
  }
  next();
});
app.use(express.static(path.join(__dirname, '../frontend/dist')));

const DB_FILE = process.env.PROGRESS_DB || '/data/progress.db';

// ── Addons system paths (env-overridable for testability) ─────────────────────
// ADDONS_DIR        — addon manifests (addons/<id>/addon.json), shipped in-repo
// ADDONS_STATE_FILE — runtime install state, persisted on the /data mount
// ADDONS_BIN_DIR    — install target for target:"os" binaries; on /data so it
//                     survives container restarts and is added to the shell PATH
const ADDONS_DIR       = process.env.ADDONS_DIR       || path.join(__dirname, '../addons');
const ADDONS_STATE_FILE = process.env.ADDONS_STATE_FILE || '/data/addons-state.json';
const ADDONS_BIN_DIR   = process.env.ADDONS_BIN_DIR   || '/data/addons/bin';

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
      { name: 'started_at',         type: 'TEXT' },
      { name: 'notes',              type: 'TEXT' },
      { name: 'time_spent_seconds', type: 'INTEGER' },
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
      status:             r.status,
      attempts:           r.attempts,
      last_validated:     r.last_validated,
      completed_at:       r.completed_at,
      started_at:         r.started_at || null,
      notes:              r.notes || null,
      time_spent_seconds: r.time_spent_seconds || 0,
    }]));
  } catch { return {}; }
}

function saveProgress(progress) {
  try {
    const db    = getDb();
    const upsert = db.prepare(`
      INSERT INTO progress (scenario_id, status, attempts, last_validated, completed_at, started_at, notes, time_spent_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scenario_id) DO UPDATE SET
        status             = excluded.status,
        attempts           = excluded.attempts,
        last_validated     = excluded.last_validated,
        completed_at       = excluded.completed_at,
        started_at         = excluded.started_at,
        notes              = excluded.notes,
        time_spent_seconds = excluded.time_spent_seconds
    `);
    db.transaction((entries) => {
      for (const [id, p] of entries) {
        upsert.run(id, p.status || null, p.attempts || 0, p.last_validated || null,
          p.completed_at || null, p.started_at || null, p.notes || null, p.time_spent_seconds || 0);
      }
    })(Object.entries(progress));
  } catch (e) {
    console.error('Failed to save progress:', e.message);
  }
}

// ── Shared utilities ──────────────────────────────────────────────────────────

async function runCommand(cmd, timeoutMs = 15000) {
  try {
    const { stdout } = await execAsync(cmd, {
      timeout:  timeoutMs,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH:       `${ADDONS_BIN_DIR}:${process.env.PATH || ''}`,
        KUBECONFIG: process.env.KUBECONFIG || '/root/.kube/config',
      },
    });
    return { success: true, output: stdout.trim() };
  } catch (e) {
    return { success: false, output: (e.stdout || '').trim(), error: (e.stderr || e.message || '').trim() };
  }
}

function checkMatch(actual, expected, matchType) {
  const a = String(actual).trim();
  const e = String(expected).trim();
  if (matchType === 'exact')       return a === e;
  if (matchType === 'contains')    return a.includes(e);
  if (matchType === 'not_contains') return !a.includes(e);
  if (matchType === 'regex')       return new RegExp(e).test(a);
  return a === e;
}

// ── WebSocket / PTY state — shared with scenarios router via injection ─────────
// Active WebSocket terminal clients — write output directly (NOT as shell input)
const activeWsClients = new Set();
// Active PTY shells — used only to write '\r' and trigger PS1 prompt repaint
const activeShells    = new Set();

// Inject text directly into all terminals as output (never touches shell stdin)
function injectToTerminal(text) {
  for (const ws of activeWsClients) {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(text); } catch (_) {}
  }
}

// Write a carriage-return to every active shell so bash repaints its PS1 prompt
function refreshPrompt(delayMs = 80) {
  setTimeout(() => {
    for (const shell of activeShells) {
      try { shell.write('\r'); } catch (_) {}
    }
  }, delayMs);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

// Initial cache populate
reloadCache();

// Addons: repair any jobs left mid-flight by a previous container run
try {
  const state      = readState(ADDONS_STATE_FILE);
  const reconciled = reconcileInterrupted(state);
  if (JSON.stringify(reconciled) !== JSON.stringify(state)) {
    writeState(ADDONS_STATE_FILE, reconciled);
    console.log('Reconciled interrupted addon jobs from a previous run.');
  }
} catch (e) {
  console.error('Addon state reconciliation failed:', e.message);
}

// ── Mount routes ──────────────────────────────────────────────────────────────

const routeDeps = { getDb, loadProgress, saveProgress, runCommand, checkMatch, injectToTerminal, refreshPrompt };

app.use('/api/tracks',    createTracksRouter(routeDeps));
app.use('/api/bundles',   createBundlesRouter(routeDeps));
app.use('/api/scenarios', createScenariosRouter(routeDeps));
app.use('/api/progress',  createProgressRouter(routeDeps));
app.use('/api/sessions',  createSessionsRouter(routeDeps));
app.use('/api/cache',     createCacheRouter());
app.use('/api/health',    createHealthRouter(routeDeps));

// Addons API — async install/remove engine + SSE streaming
const addonEngine = createJobEngine({
  loadAddons,
  stateFile: ADDONS_STATE_FILE,
  binDir:    ADDONS_BIN_DIR,
});
app.use('/api/addons', createAddonsRouter({ loadAddons, stateFile: ADDONS_STATE_FILE, engine: addonEngine }));

// Best-effort: re-install addons whose health check fails after a restart
// (e.g. OS binaries lost on an ephemeral filesystem). Non-blocking.
addonEngine.healthReconcile().catch(e => console.error('addon health reconcile failed:', e.message));

// Fallback to frontend SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

// ── WebSocket PTY terminal ────────────────────────────────────────────────────
const http      = require('http');
const WebSocket = require('ws');
const pty       = require('node-pty');

const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws) => {
  activeWsClients.add(ws);

  const shell = pty.spawn('/bin/bash', [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd:  '/root',
    env:  {
      ...process.env,
      KUBECONFIG: '/root/.kube/config',
      HOME:       '/root',
      TERM:       'xterm-256color',
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
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => console.log(`API server running on :${PORT}`));
