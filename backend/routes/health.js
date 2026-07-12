'use strict';

const { Router } = require('express');

/**
 * GET /api/health
 * Returns API liveness and k3s cluster reachability.
 */
function createHealthRouter({ runCommand }) {
  const router = Router();

  router.get('/', async (req, res) => {
    const kube = await runCommand('kubectl cluster-info --request-timeout=3s 2>&1 | head -1');
    res.type('application/json').json({
      api:          'ok',
      cluster:      kube.success ? 'ready' : 'not_ready',
      cluster_info: kube.output,
    });
  });

  return router;
}

module.exports = { createHealthRouter };
