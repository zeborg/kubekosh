'use strict';

// Read-only addon HTTP routes (Phase 1). Install/remove + SSE land in Phase 3.
// Built as a router factory so it can be mounted into server.js and tested in
// isolation with injected manifests + a temp state file.

const express = require('express');
const {
  ID_RE,
  buildIndex,
  resolveInstallOrder,
  getDependents
} = require('../lib/addons');
const { readState, statusOf } = require('../lib/addon-state');

/**
 * Merge a manifest with its live runtime status for API responses.
 */
function mergeStatus(addon, state) {
  const entry = state[addon.id] || {};
  return {
    ...addon,
    status: entry.status || 'available',
    installed_version: entry.version || null,
    last_error: entry.last_error || null,
    updated_at: entry.updated_at || null,
    queued_action: entry.queued_action || null,
    // Remote logo URL from the manifest; null → UI falls back to the emoji icon.
    logo_url: addon.logo || null
  };
}

/**
 * Compute the resolved install plan surfaced to the UI: the transitive
 * dependency order with each step tagged install/skip based on current status.
 */
function buildInstallPlan(id, index, state) {
  try {
    const order = resolveInstallOrder(id, index);
    const steps = order.map((depId) => {
      const status = statusOf(state, depId);
      const installedVer = state[depId]?.version ?? null;
      const manifestVer = index.get(depId).version;
      const upToDate = status === 'installed' && installedVer === manifestVer;
      // installed-but-outdated → upgrade; not installed → install; else skip.
      const action = upToDate ? 'skip' : (status === 'installed' ? 'upgrade' : 'install');
      return { id: depId, name: index.get(depId).name, status, action, installed_version: installedVer, version: manifestVer };
    });
    return {
      order: steps,
      to_install: steps.filter((s) => s.action !== 'skip').length,
      already_satisfied: steps.filter((s) => s.action === 'skip').map((s) => s.id)
    };
  } catch (e) {
    // Broken graph (cycle / missing dep): report rather than 500.
    return { error: e.message, order: [], to_install: 0, already_satisfied: [] };
  }
}

/**
 * @param {object} deps
 * @param {() => object[]} deps.loadAddons returns cached manifests
 * @param {string} deps.stateFile path to the runtime state JSON
 * @param {object} [deps.engine] async install/remove engine (Phase 3); when
 *   omitted the router stays read-only.
 * @returns {import('express').Router}
 */
function createAddonsRouter({ loadAddons, stateFile, engine }) {
  const router = express.Router();

  // GET /api/addons — full catalog with live status
  router.get('/', (req, res) => {
    const addons = loadAddons();
    const state = readState(stateFile);
    res.type('application/json').json(addons.map((a) => mergeStatus(a, state)));
  });

  // GET /api/addons/:id — one addon + resolved install plan + dependents
  router.get('/:id', (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) {
      return res.type('application/json').status(400).json({ error: 'invalid addon id' });
    }
    const addons = loadAddons();
    const index = buildIndex(addons);
    const addon = index.get(id);
    if (!addon) {
      return res.type('application/json').status(404).json({ error: `addon "${id}" not found` });
    }
    const state = readState(stateFile);
    res.type('application/json').json({
      ...mergeStatus(addon, state),
      install_plan: buildInstallPlan(id, index, state),
      dependents: getDependents(id, addons)
    });
  });

  // The mutation + streaming endpoints require the job engine (Phase 3).
  if (engine) {
    const validId = (req, res) => {
      if (ID_RE.test(req.params.id)) return true;
      res.type('application/json').status(400).json({ error: 'invalid addon id' });
      return false;
    };

    // POST /api/addons/:id/install — enqueue install (+ transitive deps)
    router.post('/:id/install', (req, res) => {
      if (!validId(req, res)) return;
      const r = engine.enqueueInstall(req.params.id);
      if (r.error) return res.type('application/json').status(r.code || 400).json({ error: r.error, dependents: r.dependents });
      res.type('application/json').status(202).json({ accepted: true, jobId: r.jobId, plan: r.plan });
    });

    // POST /api/addons/:id/remove — enqueue removal (blocked if depended upon)
    router.post('/:id/remove', (req, res) => {
      if (!validId(req, res)) return;
      const r = engine.enqueueRemove(req.params.id);
      if (r.error) return res.type('application/json').status(r.code || 400).json({ error: r.error, dependents: r.dependents });
      res.type('application/json').status(202).json({ accepted: true, jobId: r.jobId });
    });

    // POST /api/addons/:id/cancel — cancel an in-progress install and revert it
    router.post('/:id/cancel', (req, res) => {
      if (!validId(req, res)) return;
      const r = engine.cancel(req.params.id);
      if (r.error) return res.type('application/json').status(r.code || 400).json({ error: r.error });
      res.type('application/json').status(202).json({ accepted: true, reverting: r.reverting });
    });

    // GET /api/addons/:id/status — polling fallback
    router.get('/:id/status', (req, res) => {
      if (!validId(req, res)) return;
      res.type('application/json').json({ id: req.params.id, ...engine.getStatus(req.params.id) });
    });

    // GET /api/addons/:id/stream — SSE log + status stream
    router.get('/:id/stream', (req, res) => {
      if (!validId(req, res)) return;
      const lastEventId = Number(req.headers['last-event-id']) || 0;
      engine.subscribe(req.params.id, res, lastEventId);
    });
  }

  return router;
}

module.exports = { createAddonsRouter, mergeStatus, buildInstallPlan };
