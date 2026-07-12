'use strict';

const { getDb } = require('./index');

// ── Session operations ────────────────────────────────────────────────────────

/**
 * Abandon any existing active session, then create a new one.
 * Returns the created session object.
 *
 * @param {string}   bundleId
 * @param {number}   mins          — exam duration in minutes
 * @param {string[]} scenarioIds   — pre-shuffled/sliced scenario id list
 */
function createSession(bundleId, mins, scenarioIds) {
  const db = getDb();

  // Abandon any currently active session before starting a new one
  db.prepare(`UPDATE sessions SET status='abandoned', submitted_at=datetime('now')
              WHERE status='active'`).run();

  const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`INSERT INTO sessions (id, bundle_id, started_at, status, exam_minutes, scenario_ids)
              VALUES (?, ?, datetime('now'), 'active', ?, ?)`)
    .run(id, bundleId, mins, JSON.stringify(scenarioIds));

  return { id, bundleId, status: 'active', exam_minutes: mins, scenario_ids: scenarioIds };
}

/**
 * Return the raw active session row, or null if none exists.
 */
function getActiveSession() {
  return getDb().prepare(
    `SELECT * FROM sessions WHERE status='active' ORDER BY started_at DESC LIMIT 1`
  ).get() || null;
}

/**
 * Return the number of scenarios marked 'completed' in a session's exam_progress.
 *
 * @param {string} sessionId
 */
function getCompletedCount(sessionId) {
  return getDb().prepare(
    `SELECT COUNT(*) as cnt FROM exam_progress WHERE session_id=? AND status='completed'`
  ).get(sessionId)?.cnt || 0;
}

/**
 * Return all non-active session rows, newest first.
 */
function getSessionHistory() {
  return getDb().prepare(
    `SELECT * FROM sessions WHERE status != 'active' ORDER BY started_at DESC`
  ).all();
}

/**
 * Return a single session row by id, or null if not found.
 *
 * @param {string} id
 */
function getSessionById(id) {
  return getDb().prepare(`SELECT * FROM sessions WHERE id=?`).get(id) || null;
}

/**
 * Return per-scenario exam progress for a session as a keyed map:
 *   { [scenario_id]: { status, attempts, completed_at } }
 *
 * @param {string} sessionId
 */
function getExamProgress(sessionId) {
  const rows   = getDb().prepare(`SELECT * FROM exam_progress WHERE session_id=?`).all(sessionId);
  const result = {};
  for (const r of rows) {
    result[r.scenario_id] = { status: r.status, attempts: r.attempts, completed_at: r.completed_at };
  }
  return result;
}

/**
 * Mark a session as 'submitted', persist the snapshot, and reset per-scenario
 * timers in the progress table for all scenarios in the bundle.
 *
 * @param {string}   sessionId
 * @param {Object[]} snapshot           — array of scenario result objects
 * @param {number}   durationSecs
 * @param {string[]} bundleScenarioIds  — used to clear timers in progress table
 */
function submitSession(sessionId, snapshot, durationSecs, bundleScenarioIds) {
  const db = getDb();
  db.prepare(`UPDATE sessions SET status='submitted', submitted_at=datetime('now'),
              duration_secs=?, snapshot=? WHERE id=?`)
    .run(durationSecs, JSON.stringify(snapshot), sessionId);

  const clearTimer = db.prepare(
    `UPDATE progress SET started_at = NULL, time_spent_seconds = 0 WHERE scenario_id = ?`
  );
  db.transaction(ids => ids.forEach(id => clearTimer.run(id)))(bundleScenarioIds);
}

/**
 * Mark a session as 'abandoned' and optionally reset per-scenario timers.
 *
 * @param {string}   sessionId
 * @param {string[]} [bundleScenarioIds]  — pass to clear timers; omit if bundle not found
 */
function abandonSession(sessionId, bundleScenarioIds) {
  const db = getDb();
  db.prepare(`UPDATE sessions SET status='abandoned', submitted_at=datetime('now')
                             WHERE id=? AND status='active'`).run(sessionId);

  if (bundleScenarioIds?.length) {
    const clearTimer = db.prepare(
      `UPDATE progress SET started_at = NULL, time_spent_seconds = 0 WHERE scenario_id = ?`
    );
    db.transaction(ids => ids.forEach(id => clearTimer.run(id)))(bundleScenarioIds);
  }
}

module.exports = {
  createSession,
  getActiveSession,
  getCompletedCount,
  getSessionHistory,
  getSessionById,
  getExamProgress,
  submitSession,
  abandonSession,
};
