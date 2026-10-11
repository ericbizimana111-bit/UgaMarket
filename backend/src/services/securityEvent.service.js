const prisma = require('../config/db');
const logger = require('../utils/logger');
const { maskTarget } = require('./messaging');

/**
 * Account-security audit trail. Best effort: a failed write is logged and
 * never breaks the request that triggered it. Codes and passwords are never
 * recorded; destinations are masked.
 */

const SECURITY_EVENTS = {
  OTP_SENT: 'OTP_SENT',
  OTP_SEND_FAILED: 'OTP_SEND_FAILED',
  OTP_VERIFIED: 'OTP_VERIFIED',
  OTP_FAILED: 'OTP_FAILED',
  OTP_LOCKED: 'OTP_LOCKED',
  OTP_RATE_LIMITED: 'OTP_RATE_LIMITED',
  REGISTERED: 'REGISTERED',
  EMAIL_VERIFIED: 'EMAIL_VERIFIED',
  PHONE_VERIFIED: 'PHONE_VERIFIED',
  EMAIL_CHANGED: 'EMAIL_CHANGED',
  PHONE_CHANGED: 'PHONE_CHANGED',
  PASSWORD_RESET_REQUESTED: 'PASSWORD_RESET_REQUESTED',
  PASSWORD_RESET: 'PASSWORD_RESET',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  MARKETING_CONSENT_CHANGED: 'MARKETING_CONSENT_CHANGED',
};

/** IP + user agent of a request, trimmed to the column sizes. */
function requestContext(req) {
  if (!req) return { ip: null, userAgent: null };
  return {
    ip: req.ip ? String(req.ip).slice(0, 64) : null,
    userAgent: req.headers?.['user-agent'] ? String(req.headers['user-agent']).slice(0, 300) : null,
  };
}

async function recordSecurityEvent({ userId = null, type, target = null, ctx = {}, metadata = null }) {
  try {
    await prisma.securityEvent.create({
      data: {
        userId,
        type,
        target: target ? maskTarget(target) : null,
        ipAddress: ctx.ip || null,
        userAgent: ctx.userAgent || null,
        metadata: metadata || undefined,
      },
    });
  } catch (error) {
    logger.warn(`[security] could not record ${type}: ${error.message}`);
  }
}

module.exports = { SECURITY_EVENTS, recordSecurityEvent, requestContext };
