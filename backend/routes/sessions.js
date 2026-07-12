'use strict';

const { Router } = require('express');
const { loadBundles, loadScenarios } = require('../lib/cache');
const {
  createSession,
  getActiveSession,
  getCompletedCount,
  getSessionHistory,
  getSessionById,
  getExamProgress,
  submitSession,
  abandonSession,
} = require('../db/sessions');

// Fisher-Yates shuffle (returns a new array)
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * POST   /api/sessions                     — start a new exam session
 * GET    /api/sessions/active              — get the current active session
 * GET    /api/sessions/history             — list completed/abandoned sessions
 * GET    /api/sessions/:id/exam-progress   — per-scenario progress for a session
 * POST   /api/sessions/:id/submit          — submit the exam
 * POST   /api/sessions/:id/abandon         — forfeit the exam
 */
function createSessionsRouter({ loadProgress }) {
  const router = Router();

  // POST /api/sessions — start a new exam session
  router.post('/', (req, res) => {
    const { bundleId, examMinutes, scenarioCount } = req.body;
    const bundle = loadBundles().find(b => b.id === bundleId);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    const mins             = Math.max(5, Math.min(300, Number(examMinutes) || bundle.exam_minutes || 120));
    const allIds           = bundle.scenario_ids || [];
    const count            = Math.max(1, Math.min(allIds.length, Number(scenarioCount) || allIds.length));
    const sessionScenarioIds = shuffle(allIds).slice(0, count);

    const session = createSession(bundleId, mins, sessionScenarioIds);
    res.json(session);
  });

  // GET /api/sessions/active
  // NOTE: registered before /:id to prevent "active" being treated as a session id
  router.get('/active', (req, res) => {
    const session = getActiveSession();
    if (!session) return res.json(null);

    // Parse stored scenario_ids; fall back to bundle list for legacy sessions
    let scenarioIds = [];
    try { scenarioIds = session.scenario_ids ? JSON.parse(session.scenario_ids) : []; } catch (_) {}
    if (!scenarioIds.length) {
      const bundle = loadBundles().find(b => b.id === session.bundle_id);
      scenarioIds  = bundle?.scenario_ids || [];
    }

    const completedCount = getCompletedCount(session.id);
    res.json({ ...session, scenario_ids: scenarioIds, scenarioCount: scenarioIds.length, completedCount });
  });

  // GET /api/sessions/history — list completed/abandoned sessions (newest first)
  router.get('/history', (req, res) => {
    const sessions = getSessionHistory();
    const bundles  = loadBundles();

    const result = sessions.map(s => {
      const bundle       = bundles.find(b => b.id === s.bundle_id);
      let snapshot       = [];
      try { snapshot     = s.snapshot ? JSON.parse(s.snapshot) : []; } catch (_) {}
      const completed    = snapshot.filter(x => x.status === 'completed');
      const totalWeight  = snapshot.reduce((a, x) => a + (x.weight || 0), 0);
      const earnedWeight = completed.reduce((a, x) => a + (x.weight || 0), 0);
      const pct          = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0;

      return {
        id:             s.id,
        bundle_id:      s.bundle_id,
        bundle_name:    bundle?.name || s.bundle_id,
        bundle_icon:    bundle?.icon || '🎓',
        status:         s.status,
        started_at:     s.started_at,
        submitted_at:   s.submitted_at,
        exam_minutes:   s.exam_minutes,
        duration_secs:  s.duration_secs,
        scenarioCount:  snapshot.length,
        completedCount: completed.length,
        totalWeight,
        earnedWeight,
        pct,
        passed:   pct >= 66,
        snapshot,
      };
    });

    res.json(result);
  });

  // GET /api/sessions/:id/exam-progress
  router.get('/:id/exam-progress', (req, res) => {
    res.json(getExamProgress(req.params.id));
  });

  // POST /api/sessions/:id/submit — submit the exam session
  router.post('/:id/submit', (req, res) => {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const bundle    = loadBundles().find(b => b.id === session.bundle_id);
    const scenarios = loadScenarios();

    let sessionIds = [];
    try { sessionIds = session.scenario_ids ? JSON.parse(session.scenario_ids) : []; } catch (_) {}
    if (!sessionIds.length) sessionIds = bundle?.scenario_ids || [];

    const bundleScenarios  = sessionIds.map(id => scenarios.find(s => s.id === id)).filter(Boolean);
    const examProgressMap  = getExamProgress(req.params.id);
    const globalProgress   = loadProgress();

    const snapshot = bundleScenarios.map(s => ({
      id:                 s.id,
      title:              s.title,
      weight:             s.weight,
      category:           s.category,
      type:               s.type,
      difficulty:         s.difficulty,
      status:             examProgressMap[s.id]?.status       || 'not_started',
      completed_at:       examProgressMap[s.id]?.completed_at || null,
      attempts:           examProgressMap[s.id]?.attempts     || 0,
      time_spent_seconds: globalProgress[s.id]?.time_spent_seconds || 0,
    }));

    const startedAt    = new Date(session.started_at + 'Z');
    const durationSecs = Math.round((Date.now() - startedAt.getTime()) / 1000);

    submitSession(req.params.id, snapshot, durationSecs, bundle.scenario_ids);
    res.json({ ok: true, snapshot, durationSecs });
  });

  // POST /api/sessions/:id/abandon — forfeit the exam without a score report
  router.post('/:id/abandon', (req, res) => {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const bundle = loadBundles().find(b => b.id === session.bundle_id);
    abandonSession(req.params.id, bundle?.scenario_ids);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createSessionsRouter };
