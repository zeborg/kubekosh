'use strict';

const { Router } = require('express');
const { reloadCache, loadScenarios, loadBundles, loadTracks, loadAddons } = require('../lib/cache');

/**
 * POST /api/cache/reload
 * Flush and repopulate all in-memory caches from disk.
 */
function createCacheRouter() {
  const router = Router();

  router.post('/reload', (req, res) => {
    reloadCache();
    res.json({
      ok: true,
      message: 'Cache reloaded successfully',
      scenarios_count: loadScenarios().length,
      bundles_count:   loadBundles().length,
      tracks_count:    loadTracks().length,
      addons_count:    loadAddons().length,
    });
  });

  return router;
}

module.exports = { createCacheRouter };
