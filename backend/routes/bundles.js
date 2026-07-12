'use strict';

const { Router } = require('express');
const { loadBundles, loadScenarios } = require('../lib/cache');

/**
 * GET /api/bundles
 * List all bundles with per-bundle completion stats.
 */
function createBundlesRouter({ loadProgress }) {
  const router = Router();

  router.get('/', (req, res) => {
    const bundles  = loadBundles();
    const progress = loadProgress();

    const result = bundles.map(b => {
      const total     = b.scenario_ids.length;
      const completed = b.scenario_ids.filter(id => progress[id]?.status === 'completed').length;
      return { ...b, stats: { total, completed } };
    });

    res.json(result);
  });

  return router;
}

module.exports = { createBundlesRouter };
