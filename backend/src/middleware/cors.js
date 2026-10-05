const cors = require('cors');
const env = require('../config/env');
const { AppError } = require('./errorHandler');

const normalizeOrigin = (origin) => origin.trim().replace(/\/+$/, '');

const allowedOrigins = env.CORS_ORIGIN.split(',').map(normalizeOrigin);

const baseOptions = {
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'auth-token', 'X-Requested-With'],
};

/** Same-origin request (site and API on one host, e.g. behind the nginx proxy)? */
function isSameOrigin(origin, req) {
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

/**
 * Cross-origin policy. Allowed:
 *  - requests without Origin (mobile apps, curl, server-to-server);
 *  - same-origin requests — browsers send Origin on POST/PUT even to their
 *    own site, so a storefront served behind the same proxy as /api must
 *    never depend on CORS_ORIGIN listing its own domain;
 *  - origins listed in CORS_ORIGIN (CRA's dev proxy adds a trailing slash).
 * Anything else is refused with 403 (a policy decision, not a server error).
 */
const corsMiddleware = cors((req, callback) => {
  const origin = req.get('origin');
  if (!origin || isSameOrigin(origin, req) || allowedOrigins.includes(normalizeOrigin(origin)) || allowedOrigins.includes('*')) {
    return callback(null, { ...baseOptions, origin: true });
  }
  return callback(new AppError(`CORS origin ${origin} not permitted`, 403));
});

module.exports = corsMiddleware;
