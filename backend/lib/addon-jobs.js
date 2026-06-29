'use strict';

// Async addon install/remove engine.
//
// - A single FIFO queue with concurrency 1 serializes all cluster/OS mutations.
// - Installing an addon expands its transitive dependency chain (deepest first)
//   into the queue; the requested addon ("root") runs last.
// - Each job runs setup_commands / teardown_commands sequentially via spawn,
//   streaming output line-by-line to SSE subscribers, then verifies health.
// - Events are buffered per stream key (ring buffer) so a (re)connecting client
//   can replay missed output via the Last-Event-ID header.
//
// State transitions are persisted to disk on every change so the read-only
// routes and a future restart stay consistent.

const { spawn } = require('child_process');
const { buildIndex, resolveInstallOrder, getDependents, detectArch } = require('./addons');
const { readState, writeState, setStatus, statusOf } = require('./addon-state');

const RING_SIZE = 500;        // events retained per stream key for SSE replay
const HEALTH_TIMEOUT_MS = 30000;

function substitute(cmd, vars) {
  return cmd.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function createJobEngine({ loadAddons, stateFile, binDir = '/data/addons/bin', baseEnv = process.env, retryIntervalMs = 60000 }) {
  let state = readState(stateFile);
  const queue = [];
  let running = false;
  let sweeping = false;
  let currentJob = null;        // job presently executing (for cancellation)
  let currentChild = null;      // its running child process (to kill on cancel)
  const operations = new Map(); // rootId -> { plan: string[] } for active installs

  const subscribers = new Map(); // streamKey -> Set<res>
  const buffers = new Map();     // streamKey -> { id, event, data }[]
  let eventSeq = 0;

  // ── env / persistence ──────────────────────────────────────────────────────
  function runEnv() {
    return {
      ...baseEnv,
      KUBECONFIG: baseEnv.KUBECONFIG || '/root/.kube/config',
      HOME: baseEnv.HOME || '/root',
      PATH: `${binDir}:${baseEnv.PATH || ''}`
    };
  }

  function persist() {
    try { writeState(stateFile, state); }
    catch (e) { console.error('addon state persist failed:', e.message); }
  }

  // An addon needs (re)installing if it isn't installed, or the installed
  // version differs from the manifest's — i.e. an in-place upgrade/downgrade.
  function needsInstall(id, manifest) {
    if (statusOf(state, id) !== 'installed') return true;
    return (state[id]?.version ?? null) !== manifest.version;
  }

  // ── SSE plumbing ───────────────────────────────────────────────────────────
  function pushBuffer(key, frame) {
    let buf = buffers.get(key);
    if (!buf) { buf = []; buffers.set(key, buf); }
    buf.push(frame);
    if (buf.length > RING_SIZE) buf.splice(0, buf.length - RING_SIZE);
  }

  function writeFrame(res, frame) {
    res.write(`id: ${frame.id}\n`);
    res.write(`event: ${frame.event}\n`);
    res.write(`data: ${JSON.stringify(frame.data)}\n\n`);
  }

  function broadcast(keys, event, data) {
    const frame = { id: ++eventSeq, event, data };
    for (const key of keys) {
      pushBuffer(key, frame);
      const subs = subscribers.get(key);
      if (subs) for (const res of subs) {
        try { writeFrame(res, frame); } catch { /* dropped on next close */ }
      }
    }
  }

  function broadcastLog(keys, addonId, line, stream) {
    broadcast(keys, 'log', { addon: addonId, line, stream, ts: new Date().toISOString() });
  }

  function setAddonStatus(id, patch, keys) {
    state = setStatus(state, id, patch);
    persist();
    broadcast(keys && keys.length ? keys : [id], 'status', {
      addon: id,
      status: patch.status,
      last_error: 'last_error' in patch ? patch.last_error : (state[id]?.last_error ?? null)
    });
  }

  // Kill a child and the whole process group it leads (so SIGKILL also stops
  // curl/kubectl/etc. spawned by the bash command, not just bash itself).
  function killTree(child, signal) {
    if (!child) return;
    try { process.kill(-child.pid, signal); }
    catch { try { child.kill(signal); } catch { /* already gone */ } }
  }

  // ── command execution ──────────────────────────────────────────────────────
  function runCmd(command, { keys, addonId, timeoutMs, onChild }) {
    return new Promise((resolve, reject) => {
      // detached:true makes the child a process-group leader so killTree can
      // signal the entire group.
      const child = spawn('bash', ['-lc', command], { env: runEnv(), detached: true });
      if (onChild) onChild(child);
      let settled = false;
      const buffers = { stdout: '', stderr: '' };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killTree(child, 'SIGKILL');
        reject(new Error(`command timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      function onData(streamName) {
        return (chunk) => {
          buffers[streamName] += chunk.toString();
          const lines = buffers[streamName].split('\n');
          buffers[streamName] = lines.pop(); // keep partial line
          for (const line of lines) broadcastLog(keys, addonId, line, streamName);
        };
      }
      child.stdout.on('data', onData('stdout'));
      child.stderr.on('data', onData('stderr'));

      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // flush any trailing partial lines
        for (const s of ['stdout', 'stderr']) {
          if (buffers[s]) broadcastLog(keys, addonId, buffers[s], s);
        }
        if (code === 0) resolve();
        else reject(new Error(`command exited with code ${code}`));
      });
    });
  }

  // ── job execution ──────────────────────────────────────────────────────────
  async function runJob(job) {
    const addon = buildIndex(loadAddons()).get(job.addonId);
    if (!addon) return;

    const keys = job.rootId && job.rootId !== job.addonId
      ? [job.addonId, job.rootId]
      : [job.addonId];
    const isInstall = job.action === 'install';

    // Idempotency: skip an install only when the addon is already at this
    // version. A version mismatch falls through and re-runs setup (upgrade).
    if (isInstall && !needsInstall(job.addonId, addon)) return;

    setAddonStatus(job.addonId, { status: isInstall ? 'installing' : 'removing', last_error: null }, keys);

    const cmds = isInstall ? addon.setup_commands : addon.teardown_commands;
    const vars = { VERSION: addon.version, ARCH: detectArch(), ADDON_BIN: binDir };
    const timeoutMs = (addon.est_seconds || 60) * 3 * 1000;
    const onChild = (c) => { currentChild = c; };

    try {
      for (const c of cmds) {
        if (job.aborted) throw new Error('canceled');
        broadcastLog(keys, job.addonId, `$ ${c.label || c.command}`, 'meta');
        await runCmd(substitute(c.command, vars), { keys, addonId: job.addonId, timeoutMs, onChild });
      }

      if (isInstall) {
        if (job.aborted) throw new Error('canceled');
        broadcastLog(keys, job.addonId, '$ verifying health', 'meta');
        await runCmd(substitute(addon.health_command, vars), { keys, addonId: job.addonId, timeoutMs: HEALTH_TIMEOUT_MS, onChild });
        setAddonStatus(job.addonId, { status: 'installed', version: addon.version, last_error: null }, keys);
        if (job.addonId === job.rootId) operations.delete(job.rootId);
      } else {
        setAddonStatus(job.addonId, { status: 'available', version: null, last_error: null }, keys);
      }
    } catch (e) {
      // Cancellation: don't mark failed — a revert (teardown) job is already
      // queued to undo any partial changes and return it to 'available'.
      if (job.aborted) {
        broadcastLog(keys, job.addonId, '✗ canceled — reverting changes', 'meta');
        return;
      }
      const failStatus = isInstall ? 'install_failed' : 'remove_failed';
      setAddonStatus(job.addonId, { status: failStatus, last_error: e.message }, keys);
      broadcastLog(keys, job.addonId, `✗ ${e.message}`, 'meta');

      // A failed dependency aborts the rest of the chain and fails the root.
      if (isInstall && job.rootId && job.rootId !== job.addonId) {
        for (let i = queue.length - 1; i >= 0; i--) {
          if (queue[i].rootId === job.rootId) queue.splice(i, 1);
        }
        setAddonStatus(job.rootId, {
          status: 'install_failed',
          last_error: `dependency "${job.addonId}" failed: ${e.message}`
        }, [job.rootId]);
      }
      if (isInstall) operations.delete(job.rootId);
    }
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        currentJob = queue.shift();
        currentChild = null;
        try { await runJob(currentJob); }
        finally { currentJob = null; currentChild = null; }
      }
    } finally {
      running = false;
    }
  }

  // ── public API ─────────────────────────────────────────────────────────────
  function enqueueInstall(rootId) {
    const addons = loadAddons();
    const index = buildIndex(addons);
    if (!index.has(rootId)) return { error: `addon "${rootId}" not found`, code: 404 };

    let order;
    try { order = resolveInstallOrder(rootId, index); }
    catch (e) { return { error: e.message, code: 400 }; }

    // Skip anything already in flight (queued or running) so re-clicks and
    // overlapping installs don't enqueue the same addon twice.
    const inFlight = (id) => ['queued', 'installing', 'removing'].includes(statusOf(state, id));
    const pending = order.filter(id => needsInstall(id, index.get(id)) && !inFlight(id));
    if (pending.length === 0) {
      return { error: 'addon and all dependencies are already installed or in progress', code: 409 };
    }
    // Start each operation with a clean log buffer so a (re)connecting client
    // replays only the current run's output, not stale output from prior runs.
    buffers.delete(rootId);
    for (const id of pending) buffers.delete(id);
    // Track the operation so it can be cancelled (and its addons reverted).
    operations.set(rootId, { plan: [...pending] });
    for (const id of pending) {
      // Mark queued immediately so the UI shows pending state while the
      // single-concurrency queue works through earlier jobs.
      const keys = id !== rootId ? [id, rootId] : [id];
      setAddonStatus(id, { status: 'queued', queued_action: 'install', last_error: null }, keys);
      queue.push({ addonId: id, action: 'install', rootId });
    }
    drain().catch(e => console.error('addon drain failed:', e && e.message));
    return { accepted: true, jobId: rootId, plan: pending };
  }

  // Cancel an in-progress install: drop its queued jobs, kill the running
  // command, and queue idempotent teardown (revert) jobs to undo any changes
  // made so far, returning every touched addon to 'available'.
  function cancel(rootId) {
    const op = operations.get(rootId);
    if (!op) return { error: 'no active installation to cancel', code: 409 };
    operations.delete(rootId);

    // 1. Drop not-yet-started jobs belonging to this operation.
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].rootId === rootId) queue.splice(i, 1);
    }
    // 2. Abort + hard-kill the running job if it belongs to this operation.
    if (currentJob && currentJob.rootId === rootId) {
      currentJob.aborted = true;
      killTree(currentChild, 'SIGKILL');
    }
    // 3. Revert each touched addon (root first, then deps). teardown_commands
    //    are idempotent, so they undo full or partial installs and no-op
    //    otherwise. Logs append to the existing stream for continuity.
    const revert = [...op.plan].reverse();
    for (const id of revert) {
      queue.push({ addonId: id, action: 'remove', rootId });
    }
    drain().catch(e => console.error('addon drain failed:', e && e.message));
    return { accepted: true, reverting: revert };
  }

  function enqueueRemove(id) {
    const addons = loadAddons();
    if (!buildIndex(addons).has(id)) return { error: `addon "${id}" not found`, code: 404 };

    const st = statusOf(state, id);
    if (st !== 'installed' && st !== 'remove_failed') {
      return { error: `addon "${id}" is not installed`, code: 409 };
    }
    const blockers = getDependents(id, addons).filter(d => {
      const ds = statusOf(state, d);
      return ds === 'installed' || ds === 'installing' || ds === 'queued';
    });
    if (blockers.length > 0) {
      return { error: 'addon is required by other installed addons', code: 409, dependents: blockers };
    }
    // Clean buffer so the client doesn't replay the prior install's output.
    buffers.delete(id);
    setAddonStatus(id, { status: 'queued', queued_action: 'remove', last_error: null }, [id]);
    queue.push({ addonId: id, action: 'remove', rootId: id });
    drain().catch(e => console.error('addon drain failed:', e && e.message));
    return { accepted: true, jobId: id };
  }

  function subscribe(key, res, lastEventId = 0) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');

    let subs = subscribers.get(key);
    if (!subs) { subs = new Set(); subscribers.set(key, subs); }
    subs.add(res);

    // Replay buffered events the client hasn't seen.
    const buf = buffers.get(key) || [];
    for (const frame of buf) {
      if (frame.id > lastEventId) writeFrame(res, frame);
    }

    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 15000);

    const cleanup = () => {
      clearInterval(heartbeat);
      const set = subscribers.get(key);
      if (set) { set.delete(res); if (set.size === 0) subscribers.delete(key); }
    };
    res.on('close', cleanup);
    return cleanup;
  }

  function getStatus(id) {
    return { status: statusOf(state, id), last_error: state[id]?.last_error ?? null };
  }

  // Promote an addon stuck in install_failed whose health check now passes —
  // e.g. a cluster addon whose readiness wait timed out on a cold node but came
  // up moments later. Probes health; flips to installed on success, leaves it
  // failed otherwise. Returns true if it promoted.
  async function promoteIfHealthy(id) {
    if (statusOf(state, id) !== 'install_failed') return false;
    const addon = buildIndex(loadAddons()).get(id);
    if (!addon) return false;
    const vars = { VERSION: addon.version, ARCH: detectArch(), ADDON_BIN: binDir };
    try {
      await runCmd(substitute(addon.health_command, vars), { keys: [id], addonId: id, timeoutMs: HEALTH_TIMEOUT_MS });
    } catch {
      return false; // still not healthy — leave it failed
    }
    // A real job may have changed the status while the probe ran; re-check.
    if (statusOf(state, id) !== 'install_failed') return false;
    console.log(`Addon "${id}" is healthy despite an earlier failure — marking installed.`);
    setAddonStatus(id, { status: 'installed', version: addon.version, last_error: null }, [id]);
    return true;
  }

  // Sweep every install_failed addon and auto-promote the ones now healthy.
  // Re-entrant-guarded; safe to call from the boot reconcile and the timer.
  async function sweepFailed() {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const [id, entry] of Object.entries(state)) {
        if (entry.status === 'install_failed') await promoteIfHealthy(id);
      }
    } finally {
      sweeping = false;
    }
  }

  // Best-effort: re-install addons marked installed whose health check now
  // fails (e.g. an OS binary lost when an ephemeral container restarted), and
  // auto-promote install_failed addons that are actually healthy.
  // Runs in the background; never blocks startup.
  async function healthReconcile() {
    const index = buildIndex(loadAddons());
    for (const [id, entry] of Object.entries(state)) {
      const addon = index.get(id);
      if (!addon) continue;
      if (entry.status === 'installed') {
        const vars = { VERSION: addon.version, ARCH: detectArch(), ADDON_BIN: binDir };
        try {
          await runCmd(substitute(addon.health_command, vars), { keys: [id], addonId: id, timeoutMs: HEALTH_TIMEOUT_MS });
        } catch {
          console.log(`Addon "${id}" failed health check on boot — re-installing.`);
          state = setStatus(state, id, { status: 'available', version: null });
          persist();
          enqueueInstall(id);
        }
      } else if (entry.status === 'install_failed') {
        await promoteIfHealthy(id);
      }
    }
  }

  // Periodic auto-promotion of failed-but-healthy addons. unref() so it never
  // keeps the process (or a test runner) alive on its own.
  const retryTimer = retryIntervalMs > 0
    ? setInterval(() => { sweepFailed().catch(() => {}); }, retryIntervalMs)
    : null;
  if (retryTimer && retryTimer.unref) retryTimer.unref();

  function stopRetryTimer() {
    if (retryTimer) clearInterval(retryTimer);
  }

  return { enqueueInstall, enqueueRemove, cancel, subscribe, getStatus, healthReconcile, sweepFailed, stopRetryTimer };
}

module.exports = { createJobEngine, substitute };
