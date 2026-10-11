const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { z } = require('zod');
const validateRequest = require('../middleware/requestValidator');
const newsletter = require('../services/newsletter.service');
const { requestContext } = require('../services/securityEvent.service');

const router = express.Router();

// Sign-ups send email: keep them scarce per IP.
const subscribeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 10,
  keyGenerator: (req) => ipKeyGenerator(req.ip || ''),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many sign-up attempts. Please try again later.' },
});

const token = z.string().trim().regex(/^[0-9a-f]{64}$/i, 'Invalid link');

router.post(
  '/subscribe',
  subscribeLimiter,
  validateRequest({
    body: z.object({
      email: z.string({ required_error: 'Email is required' }).trim().email('Enter a valid email address').max(255),
      language: z.string().max(5).optional(),
      // Explicit, unticked-by-default agreement to receive marketing email.
      consent: z.literal(true, { errorMap: () => ({ message: 'Please agree to receive emails from UgaMarket.' }) }),
    }),
  }),
  async (req, res, next) => {
    try {
      const data = await newsletter.subscribe(req.body, requestContext(req));
      res.json({ success: true, message: data.message, data });
    } catch (error) {
      next(error);
    }
  }
);

router.post('/confirm', validateRequest({ body: z.object({ token }) }), async (req, res, next) => {
  try {
    const data = await newsletter.confirm(req.body.token);
    res.json({ success: true, message: data.message });
  } catch (error) {
    next(error);
  }
});

router.post('/unsubscribe', validateRequest({ body: z.object({ token }) }), async (req, res, next) => {
  try {
    const data = await newsletter.unsubscribe(req.body.token, requestContext(req));
    res.json({ success: true, message: data.message });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
