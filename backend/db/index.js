'use strict';

const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');

// ── DB path (env-overridable for testability) ─────────────────────────────────
const DB_FILE = process.env.PROGRESS_DB || '/data/progress.db';

let _db = null;

/**
 * Return the singleton SQLite connection.
 * Creates the file, runs DDL, and applies any pending migrations on first call.
 */
function getDb() {
  if (_db) return _db;

  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(DB_FILE);

  // ── DDL ────────────────────────────────────────────────────────────────────

  _db.exec(`
    CREATE TABLE IF NOT EXISTS progress (
      scenario_id   TEXT PRIMARY KEY,
      status        TEXT,
      attempts      INTEGER DEFAULT 0,
      last_validated TEXT,
      completed_at  TEXT
    )
  `);

  // Migrate: add columns introduced after the initial schema
  try {
    const existingColumns = _db.prepare('PRAGMA table_info(progress)').all().map(c => c.name);
    const requiredColumns = [
      { name: 'started_at',         type: 'TEXT'    },
      { name: 'notes',              type: 'TEXT'    },
      { name: 'time_spent_seconds', type: 'INTEGER' },
    ];
    for (const col of requiredColumns) {
      if (!existingColumns.includes(col.name)) {
        console.log(`Migrating progress table: adding column '${col.name}' (${col.type})`);
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
    const cols = _db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
    if (!cols.includes('scenario_ids')) {
      _db.exec('ALTER TABLE sessions ADD COLUMN scenario_ids TEXT');
    }
  } catch (e) {
    console.error('Failed to migrate sessions table:', e.message);
  }

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

module.exports = { getDb };
