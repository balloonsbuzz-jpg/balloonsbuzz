const express = require('express');
const { z } = require('zod');
const { ah, parse } = require('../lib/errors');
const { requirePermission } = require('../middleware/auth');
const bookings = require('../bookings/bookings.service');

const router = express.Router();
const read = requirePermission('bookings:read');
const write = requirePermission('bookings:write');
const pay = requirePermission('payments:write');
const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use HH:MM');
const money = z.coerce.number().min(0).max(10_000_000);

router.get('/board', read, ah(async (req, res) => res.json(await bookings.board(req.user.tenantId))));

router.get('/capacity', read, ah(async (req, res) => {
  const { date: d } = parse(z.object({ date }), req.query);
  res.json(await bookings.dateLoad(req.user.tenantId, d));
}));

router.get('/:id', read, ah(async (req, res) => res.json({ booking: await bookings.get(req.user.tenantId, parse(uuid, req.params.id)) })));

const createBody = z.object({
  quote_id: uuid,
  event_date: date,
  event_time: time.nullable().optional(),
  venue_address: z.string().trim().min(3).max(300),
  guest_count: z.coerce.number().int().min(1).max(10000).nullable().optional(),
  special_requests: z.string().trim().max(1000).nullable().optional(),
  allow_over_capacity: z.boolean().default(false),
}).strict();

router.post('/', write, ah(async (req, res) => {
  const b = parse(createBody, req.body);
  const r = await bookings.createFromQuote({
    tenantId: req.user.tenantId, quoteId: b.quote_id, eventDate: b.event_date, eventTime: b.event_time || null,
    venueAddress: b.venue_address, guestCount: b.guest_count || null, specialRequests: b.special_requests || null,
    createdBy: { type: 'agent', userId: req.user.id }, allowOverCapacity: b.allow_over_capacity,
  });
  res.status(201).json({ booking: await bookings.get(req.user.tenantId, r.booking.id), capacity: r.capacity });
}));

const patchBody = z.object({
  event_date: date, event_time: time.nullable(), setup_time: time.nullable(),
  venue_address: z.string().trim().min(3).max(300), guest_count: z.coerce.number().int().min(1).max(10000).nullable(),
  special_requests: z.string().trim().max(1000).nullable(), internal_notes: z.string().trim().max(2000).nullable(),
  assigned_user_id: uuid.nullable(), advance_amount: money,
  allow_over_capacity: z.boolean(),
}).partial().strict();

router.patch('/:id', write, ah(async (req, res) => {
  const { allow_over_capacity: allow, ...patch } = parse(patchBody, req.body);
  res.json(await bookings.update(req, parse(uuid, req.params.id), patch, { allowOverCapacity: !!allow }));
}));

router.post('/:id/status', write, ah(async (req, res) => {
  const b = parse(z.object({ status: z.enum(bookings.STATUSES), reason: z.string().trim().min(3).max(300).optional() }).strict(), req.body);
  res.json(await bookings.setStatus(req, parse(uuid, req.params.id), b));
}));

const paymentBody = z.object({
  kind: z.enum(['payment', 'refund']).default('payment'),
  amount: z.coerce.number().positive().max(10_000_000),
  method: z.enum(['upi', 'cash', 'bank_transfer', 'gateway']),
  reference: z.string().trim().min(3).max(100).optional(),
  received_at: z.string().datetime({ offset: true }).optional(),
  notes: z.string().trim().max(500).optional(),
}).strict();

router.post('/:id/payments', pay, ah(async (req, res) => {
  res.status(201).json(await bookings.recordPayment(req, parse(uuid, req.params.id), parse(paymentBody, req.body)));
}));

module.exports = router;
