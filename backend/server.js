'use strict';

const express = require('express');
const path    = require('path');

const { loadProgress, saveProgress } = require('./db/progress');
const { getDb } = require('./db/index');

const { readState, writeState, reconcileInterrupted } = require('./lib/addon-state');
const { createJobEngine }        = require('./lib/addon-jobs');
const { reloadCache, loadAddons } = require('./lib/cache');
const { createTerminalServer }   = require('./lib/terminal');

const { createAddonsRouter }    = require('./routes/addons');
const { createTracksRouter }    = require('./routes/tracks');
const { createBundlesRouter }   = require('./routes/bundles');
const { createScenariosRouter } = require('./routes/scenarios');
const { createProgressRouter }  = require('./routes/progress');
const { createSessionsRouter }  = require('./routes/sessions');
const { createCacheRouter }     = require('./routes/cache');
const { createHealthRouter }    = require('./routes/health');

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

// ── Addons system paths (env-overridable for testability) ─────────────────────
// ADDONS_STATE_FILE — runtime install state, persisted on the /data mount
// ADDONS_BIN_DIR    — install target for target:"os" binaries; on /data so it
//                     survives container restarts and is added to the shell PATH
// NOTE: ADDONS_BIN_DIR is also read by lib/exec.js (runCommand PATH injection).
const ADDONS_STATE_FILE = process.env.ADDONS_STATE_FILE || '/data/addons-state.json';
const ADDONS_BIN_DIR    = process.env.ADDONS_BIN_DIR    || '/data/addons/bin';

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

const progressDeps = { getDb, loadProgress, saveProgress };

app.use('/api/tracks',    createTracksRouter(progressDeps));
app.use('/api/bundles',   createBundlesRouter(progressDeps));
app.use('/api/scenarios', createScenariosRouter(progressDeps));
app.use('/api/progress',  createProgressRouter(progressDeps));
app.use('/api/sessions',  createSessionsRouter(progressDeps));
app.use('/api/cache',     createCacheRouter());
app.use('/api/health',    createHealthRouter());

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

// ── HTTP + WebSocket PTY terminal ─────────────────────────────────────────────
const http   = require('http');
const server = http.createServer(app);

createTerminalServer(server);

server.listen(PORT, () => console.log(`API server running on :${PORT}`));
