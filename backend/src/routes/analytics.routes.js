// Dashboard (today at a glance, everyone) and Analytics (date range, owner/admin) + CSV export.
const express = require('express');
const { z } = require('zod');
const { ah, parse } = require('../lib/errors');
const { requirePermission } = require('../middleware/auth');
const { limits } = require('../middleware/rateLimits');
const audit = require('../services/audit.service');
const analytics = require('../analytics/analytics.service');

const router = express.Router();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Not a real date');
const rangeQuery = z.object({ from: day.optional(), to: day.optional() });

router.get('/dashboard', requirePermission('dashboard:read'), ah(async (req, res) => {
  res.json(await analytics.overview(req.user.tenantId));
}));

router.get('/analytics', requirePermission('analytics:read'), ah(async (req, res) => {
  res.json(await analytics.report(req.user.tenantId, parse(rangeQuery, req.query)));
}));

router.get('/analytics/export', requirePermission('analytics:read'), limits.export, ah(async (req, res) => {
  const q = parse(rangeQuery.extend({ kind: z.enum(['daily', 'bookings']).default('daily') }), req.query);
  const out = await analytics.exportCsv(req.user.tenantId, q.kind, q);
  await audit.fromReq(req, { action: 'analytics.export', entityType: 'analytics', after: { kind: q.kind, from: out.range.from, to: out.range.to, rows: out.rows } });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.set('Cache-Control', 'no-store');
  res.send(`\uFEFF${out.csv}`); // BOM so Excel reads ₹ and Telugu names correctly
}));

module.exports = router;
