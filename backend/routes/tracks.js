'use strict';

const { Router } = require('express');
const { loadTracks, loadBundles } = require('../lib/cache');

/**
 * GET /api/tracks
 * List all tracks with per-track completion stats.
 */
function createTracksRouter({ loadProgress }) {
  const router = Router();

  router.get('/', (req, res) => {
    const tracks   = loadTracks();
    const bundles  = loadBundles();
    const progress = loadProgress();

    const result = tracks.map(t => {
      const trackBundles    = (t.bundle_ids || []).map(id => bundles.find(b => b.id === id)).filter(Boolean);
      const allScenarioIds  = trackBundles.flatMap(b => b.scenario_ids || []);
      const total           = allScenarioIds.length;
      const completed       = allScenarioIds.filter(id => progress[id]?.status === 'completed').length;
      return { ...t, stats: { total, completed, bundles: trackBundles.length } };
    });

    res.json(result);
  });

  return router;
}

module.exports = { createTracksRouter };
