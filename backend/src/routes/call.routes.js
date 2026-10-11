const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { z } = require('zod');
const { authenticateCustomer } = require('../middleware/auth');
const { authenticateAdmin, requireRole } = require('../middleware/adminAuth');
const validateRequest = require('../middleware/requestValidator');
const callService = require('../services/call.service');

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid ID');
const idParams = z.object({ id: uuid });
const signalBody = z.object({
  type: z.enum(['offer', 'answer', 'ice']),
  data: z.unknown(),
});
const endBody = z.object({ reason: z.string().max(40).optional() });

const identity = (req) => (req.user ? `u:${req.user.id}` : req.admin ? `a:${req.admin.id}` : ipKeyGenerator(req.ip));

// ICE trickling sends bursts of small signals; anything beyond this is abuse.
const signalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 10000 : 240,
  keyGenerator: identity,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many call signals. Please try again.' },
});

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

// ------------------------------------------------------------
// Customer: /api/calls
// ------------------------------------------------------------
const customer = express.Router();
customer.use(authenticateCustomer);
const asCustomer = (req) => ({ kind: 'CUSTOMER', id: req.user.id });

customer.get('/config', (req, res) => res.json({ success: true, data: callService.callConfig() }));

customer.post(
  '/',
  handle(async (req, res) => {
    const call = await callService.startCall(req.user.id);
    res.status(201).json({ success: true, data: { call, config: callService.callConfig() } });
  })
);

customer.post(
  '/:id/signal',
  signalLimiter,
  validateRequest({ params: idParams, body: signalBody }),
  handle(async (req, res) => {
    res.json({ success: true, data: await callService.relaySignal(asCustomer(req), req.params.id, req.body) });
  })
);

customer.post(
  '/:id/end',
  validateRequest({ params: idParams, body: endBody }),
  handle(async (req, res) => {
    res.json({ success: true, data: { call: await callService.endCall(asCustomer(req), req.params.id, req.body.reason) } });
  })
);

// ------------------------------------------------------------
// Staff: /api/admin/calls
// ------------------------------------------------------------
const admin = express.Router();
admin.use(authenticateAdmin);
admin.use(requireRole('DISPATCHER', 'ADMIN', 'SUPER_ADMIN'));
const asAdmin = (req) => ({ kind: 'ADMIN', id: req.admin.id });

admin.get('/config', (req, res) => res.json({ success: true, data: callService.callConfig() }));

admin.get(
  '/',
  handle(async (req, res) => {
    res.json({ success: true, data: { calls: await callService.listCalls({ limit: req.query.limit }) } });
  })
);

admin.post(
  '/:id/accept',
  validateRequest({ params: idParams }),
  handle(async (req, res) => {
    res.json({ success: true, data: { call: await callService.acceptCall(req.admin, req.params.id), config: callService.callConfig() } });
  })
);

admin.post(
  '/:id/reject',
  validateRequest({ params: idParams }),
  handle(async (req, res) => {
    res.json({ success: true, data: { call: await callService.rejectCall(req.admin, req.params.id) } });
  })
);

admin.post(
  '/:id/signal',
  signalLimiter,
  validateRequest({ params: idParams, body: signalBody }),
  handle(async (req, res) => {
    res.json({ success: true, data: await callService.relaySignal(asAdmin(req), req.params.id, req.body) });
  })
);

admin.post(
  '/:id/end',
  validateRequest({ params: idParams, body: endBody }),
  handle(async (req, res) => {
    res.json({ success: true, data: { call: await callService.endCall(asAdmin(req), req.params.id, req.body.reason) } });
  })
);

module.exports = { customerCallRoutes: customer, adminCallRoutes: admin };
