'use strict';

// Runtime addon install state, persisted as JSON on the /data mount so it
// survives container restarts. Shape:
//
//   { "<addon-id>": { status, version, updated_at, last_error } }
//
// All mutators are pure (return a new object); writeState performs the only
// side effect via an atomic temp-write + rename.

const fs = require('fs');
const path = require('path');

const STATUSES = [
  'available',
  'queued',
  'installing',
  'installed',
  'removing',
  'install_failed',
  'remove_failed'
];

const DEFAULT_STATUS = 'available';

/**
 * Read state from disk. Returns {} if the file is missing or corrupt — a
 * fresh container simply has no installed addons yet.
 * @param {string} file
 * @returns {Record<string, object>}
 */
function readState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/**
 * Atomically persist state (write temp then rename). Creates the parent dir
 * if needed.
 * @param {string} file
 * @param {Record<string, object>} state
 */
function writeState(file, state) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Current status of an addon, defaulting to "available" when unseen.
 * @returns {string}
 */
function statusOf(state, id) {
  return (state[id] && state[id].status) || DEFAULT_STATUS;
}

/**
 * Immutably merge a patch into one addon's entry, stamping updated_at.
 * @param {Record<string, object>} state
 * @param {string} id
 * @param {object} patch
 * @param {string} [ts] ISO timestamp (injectable for deterministic tests)
 * @returns {Record<string, object>} new state object
 */
function setStatus(state, id, patch, ts = new Date().toISOString()) {
  return {
    ...state,
    [id]: {
      ...(state[id] || {}),
      ...patch,
      updated_at: patch.updated_at || ts
    }
  };
}

/**
 * Repair jobs interrupted by a crash/restart: any addon left mid-flight is
 * moved to a recoverable failed state the user can retry. Pure — returns a
 * new state object.
 *
 * @param {Record<string, object>} state
 * @param {string} [ts] ISO timestamp (injectable for deterministic tests)
 * @returns {Record<string, object>}
 */
function reconcileInterrupted(state, ts = new Date().toISOString()) {
  const next = {};
  for (const [id, entry] of Object.entries(state)) {
    if (entry.status === 'installing') {
      next[id] = {
        ...entry,
        status: 'install_failed',
        last_error: 'interrupted during install (container restart)',
        updated_at: ts
      };
    } else if (entry.status === 'removing') {
      next[id] = {
        ...entry,
        status: 'remove_failed',
        last_error: 'interrupted during removal (container restart)',
        updated_at: ts
      };
    } else if (entry.status === 'queued') {
      // Job never started before the restart — drop back to its resting state.
      next[id] = {
        ...entry,
        status: entry.queued_action === 'remove' ? 'installed' : 'available',
        last_error: null,
        updated_at: ts
      };
    } else {
      next[id] = entry;
    }
  }
  return next;
}

module.exports = {
  STATUSES,
  DEFAULT_STATUS,
  readState,
  writeState,
  statusOf,
  setStatus,
  reconcileInterrupted
};
