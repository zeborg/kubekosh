'use strict';

const { getDb } = require('./index');

/**
 * Read all rows from the `progress` table and return them as a keyed map:
 *   { [scenario_id]: { status, attempts, last_validated, completed_at,
 *                      started_at, notes, time_spent_seconds } }
 *
 * Returns {} on any error so callers always get a safe default.
 */
function loadProgress() {
  try {
    const rows = getDb().prepare('SELECT * FROM progress').all();
    return Object.fromEntries(rows.map(r => [r.scenario_id, {
      status:             r.status,
      attempts:           r.attempts,
      last_validated:     r.last_validated,
      completed_at:       r.completed_at,
      started_at:         r.started_at         || null,
      notes:              r.notes              || null,
      time_spent_seconds: r.time_spent_seconds || 0,
    }]));
  } catch {
    return {};
  }
}

/**
 * Persist the full progress map back to SQLite in a single transaction.
 * Uses INSERT … ON CONFLICT DO UPDATE (upsert) so partial updates are safe.
 *
 * @param {Object} progress  Map produced by loadProgress() or a subset.
 */
function saveProgress(progress) {
  try {
    const db     = getDb();
    const upsert = db.prepare(`
      INSERT INTO progress
        (scenario_id, status, attempts, last_validated, completed_at,
         started_at, notes, time_spent_seconds)
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
        upsert.run(
          id,
          p.status              || null,
          p.attempts            || 0,
          p.last_validated      || null,
          p.completed_at        || null,
          p.started_at          || null,
          p.notes               || null,
          p.time_spent_seconds  || 0,
        );
      }
    })(Object.entries(progress));
  } catch (e) {
    console.error('Failed to save progress:', e.message);
  }
}

module.exports = { loadProgress, saveProgress };
