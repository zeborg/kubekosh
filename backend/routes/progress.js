'use strict';

const { Router } = require('express');
const { loadScenarios, loadBundles } = require('../lib/cache');

/**
 * GET    /api/progress
 * POST   /api/progress/reset        (body: { scope, scenarioId?, category?, bundleId? })
 * POST   /api/progress/reset/:id
 */
function createProgressRouter({ getDb, loadProgress, saveProgress }) {
  const router = Router();

  // GET /api/progress — full progress summary
  router.get('/', (req, res) => {
    const scenarios   = loadScenarios();
    const progress    = loadProgress();
    const total       = scenarios.length;
    const completed   = Object.values(progress).filter(p => p.status === 'completed').length;
    const totalWeight = scenarios.reduce((sum, s) => sum + (s.weight || 0), 0);
    const earnedWeight = scenarios
      .filter(s => progress[s.id]?.status === 'completed')
      .reduce((sum, s) => sum + (s.weight || 0), 0);

    res.json({
      total,
      completed,
      score_pct: totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0,
      details: progress,
    });
  });

  // POST /api/progress/reset — bulk reset by scope
  router.post('/reset', (req, res) => {
    const { scope, scenarioId, category, bundleId } = req.body;
    const db = getDb();
    const resetStmt = db.prepare(`
      UPDATE progress
      SET status = 'not_started',
          attempts = 0,
          completed_at = NULL,
          last_validated = NULL
      WHERE scenario_id = ?
    `);

    try {
      if (scope === 'scenario') {
        resetStmt.run(scenarioId);
      } else if (scope === 'category') {
        const ids = loadScenarios().filter(s => s.category === category).map(s => s.id);
        db.transaction(ids => ids.forEach(id => resetStmt.run(id)))(ids);
      } else if (scope === 'bundle') {
        const bundle = loadBundles().find(b => b.id === bundleId);
        if (!bundle) return res.status(404).json({ error: 'Bundle not found' });
        db.transaction(ids => ids.forEach(id => resetStmt.run(id)))(bundle.scenario_ids);
      } else {
        return res.status(400).json({ error: 'Invalid scope' });
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/progress/reset/:id — reset a single scenario by id param
  router.post('/reset/:id', (req, res) => {
    try {
      getDb().prepare(`
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

  return router;
}

module.exports = { createProgressRouter };
