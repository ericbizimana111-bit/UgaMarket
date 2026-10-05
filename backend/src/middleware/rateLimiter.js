const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { verifyCustomerToken, verifyAdminToken } = require('../services/token.service');

const WINDOW_MS = 15 * 60 * 1000;
const isTest = process.env.NODE_ENV === 'test';
const intFromEnv = (name, fallback) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Who a request counts against.
 *
 * Signed-in customers and staff are limited per ACCOUNT (from a verified
 * token), not per IP: Ugandan mobile networks put many subscribers behind
 * one shared (CGNAT) IP, and per-IP limits would make shoppers block each
 * other. Anonymous traffic is limited per IP. Tokens are verified, so a forged
 * token cannot be used to dodge the limit; it simply falls back to the IP.
 */
function clientKey(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    const token = header.slice(7);
    for (const [kind, verify] of [['admin', verifyAdminToken], ['user', verifyCustomerToken]]) {
      try {
        const decoded = verify(token);
        if (decoded && decoded.sub) return `${kind}:${decoded.sub}`;
      } catch {
        /* not this kind of token */
      }
    }
  }
  return `ip:${ipKeyGenerator(req.ip || '')}`;
}

/** General API limiter (per signed-in account, otherwise per IP). */
function createApiLimiter({ max = intFromEnv('RATE_LIMIT_API_MAX', isTest ? 1000 : 600), windowMs = WINDOW_MS } = {}) {
  return rateLimit({
    windowMs,
    max,
    keyGenerator: clientKey,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests, please try again later.' },
  });
}

/**
 * Brute-force protection for credentials. Only credential ATTEMPTS count
 * (POST login / register / OTP); session checks such as GET /auth/me and
 * profile updates are not attempts, and counting them used to sign people out
 * after a few page refreshes.
 */
function createAuthLimiter({
  max = intFromEnv('RATE_LIMIT_AUTH_MAX', isTest && !process.env.TEST_RATE_LIMIT ? 1000 : 20),
  windowMs = WINDOW_MS,
} = {}) {
  return rateLimit({
    windowMs,
    max,
    skip: (req) => req.method !== 'POST',
    keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip || '')}`,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many authentication attempts, please try again in 15 minutes.' },
  });
}

module.exports = {
  apiLimiter: createApiLimiter(),
  authLimiter: createAuthLimiter(),
  createApiLimiter,
  createAuthLimiter,
  clientKey,
};
