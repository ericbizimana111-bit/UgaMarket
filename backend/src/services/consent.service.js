const prisma = require('../config/db');
const { AppError } = require('../middleware/errorHandler');
const { SECURITY_EVENTS, recordSecurityEvent } = require('./securityEvent.service');

/**
 * Customer consent (Uganda Data Protection and Privacy Act, 2019).
 *
 *  - Terms + Privacy acceptance is REQUIRED to place an order and is recorded
 *    per order with the document versions the customer was shown.
 *  - Marketing consent is OPTIONAL, off by default, separate from the
 *    contractual acceptance, and can be withdrawn at any time. Every change
 *    is appended to consent_records; users.marketing_consent holds the
 *    current state.
 *
 * Bump these versions whenever the published documents change materially
 * (they must match frontend/src/utils/legal.js).
 */
const LEGAL_VERSIONS = Object.freeze({
  terms: '2026-10-11',
  privacy: '2026-10-11',
});

function assertCurrentVersions({ termsVersion, privacyVersion }) {
  if (termsVersion !== LEGAL_VERSIONS.terms || privacyVersion !== LEGAL_VERSIONS.privacy) {
    const err = new AppError(
      'Our Terms or Privacy Policy were updated. Please refresh the page, review them and accept again.',
      409,
      [{ code: 'LEGAL_VERSION_OUTDATED', message: 'Outdated terms version', current: LEGAL_VERSIONS }]
    );
    throw err;
  }
}

/** Write the order's consent rows inside the order transaction. */
async function recordCheckoutConsents(tx, { userId, orderId, marketingConsent, ctx = {} }) {
  const base = { userId, orderId, source: 'CHECKOUT', ipAddress: ctx.ip || null, userAgent: ctx.userAgent || null };
  const rows = [
    { ...base, type: 'TERMS', granted: true, version: LEGAL_VERSIONS.terms },
    { ...base, type: 'PRIVACY', granted: true, version: LEGAL_VERSIONS.privacy },
  ];

  // Marketing: only an explicit tick is recorded as consent. An unticked box
  // never withdraws an earlier opt-in made in account settings.
  if (marketingConsent === true) {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { marketingConsent: true } });
    if (!user.marketingConsent) {
      rows.push({ ...base, type: 'MARKETING', granted: true, version: LEGAL_VERSIONS.privacy });
      await tx.user.update({ where: { id: userId }, data: { marketingConsent: true, marketingConsentAt: new Date() } });
      await require('./newsletter.service').syncFromConsent(tx, userId, true);
    }
  }
  await tx.consentRecord.createMany({ data: rows });
}

async function setMarketingConsent(userId, granted, { source = 'ACCOUNT', ctx = {}, orderId = null, syncNewsletter = true } = {}) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { marketingConsent: true } });
  if (!user) throw new AppError('User not found', 404);
  if (user.marketingConsent !== granted) {
    const now = new Date();
    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { marketingConsent: granted, marketingConsentAt: now } }),
      prisma.consentRecord.create({
        data: {
          userId,
          orderId,
          type: 'MARKETING',
          granted,
          version: LEGAL_VERSIONS.privacy,
          source,
          ipAddress: ctx.ip || null,
          userAgent: ctx.userAgent || null,
        },
      }),
    ]);
    await recordSecurityEvent({ userId, type: SECURITY_EVENTS.MARKETING_CONSENT_CHANGED, ctx, metadata: { granted, source } });
  }
  if (syncNewsletter) await require('./newsletter.service').syncFromConsent(prisma, userId, granted);
  return getCustomerConsents(userId);
}

async function getCustomerConsents(userId) {
  const [user, history] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { marketingConsent: true, marketingConsentAt: true } }),
    prisma.consentRecord.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { type: true, granted: true, version: true, source: true, createdAt: true, orderId: true },
    }),
  ]);
  return {
    marketingConsent: Boolean(user?.marketingConsent),
    marketingConsentAt: user?.marketingConsentAt || null,
    currentVersions: LEGAL_VERSIONS,
    history,
  };
}

module.exports = { LEGAL_VERSIONS, assertCurrentVersions, recordCheckoutConsents, setMarketingConsent, getCustomerConsents };
