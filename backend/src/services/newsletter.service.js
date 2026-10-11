const crypto = require('crypto');
const prisma = require('../config/db');
const env = require('../config/env');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');
const messaging = require('./messaging');
const { renderEmail } = require('./messaging/templates');
const { formatUGX } = require('../utils/currency');

/**
 * Newsletter / "new arrivals" mailing list.
 *
 *  - Double opt-in: a footer sign-up stays PENDING until the owner of the
 *    inbox clicks the emailed confirmation link (7-day, single-use token,
 *    stored hashed). Responses are identical whether or not the address is
 *    already on the list.
 *  - Customers who opt in to marketing (checkout or account settings) and
 *    have a VERIFIED email are added as ACTIVE; withdrawing removes them.
 *  - Every email carries a one-click unsubscribe link (and List-Unsubscribe
 *    header). Unsubscribing also withdraws the account's marketing consent.
 *  - A background job emails a digest of newly added products to ACTIVE
 *    subscribers and sends an in-app notification to consenting customers.
 */

const CONFIRM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESEND_CONFIRM_AFTER_MS = 2 * 60 * 1000;
const DIGEST_MAX_PRODUCTS = 8;
const SUPPORTED_LANGS = new Set(['en', 'lg', 'sw', 'fr']);

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('hex');
const shopUrl = (path = '') => `${String(env.FRONTEND_URL || '').replace(/\/$/, '')}${path}`;
const unsubscribeUrl = (token) => shopUrl(`/newsletter/unsubscribe?token=${token}`);

function normalizeEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 255) throw new AppError('Enter a valid email address', 400);
  return value;
}

async function sendConfirmation(subscriber, token) {
  const { html, text } = renderEmail({
    heading: 'Confirm your subscription',
    paragraphs: [
      'Thanks for subscribing to UgaMarket news. Please confirm your email address to start receiving new arrivals and offers.',
      'If you did not sign up, simply ignore this email and you will not be subscribed.',
    ],
    cta: { url: shopUrl(`/newsletter/confirm?token=${token}`), label: 'Confirm my subscription' },
    footerNote: 'This link expires in 7 days.',
  });
  return messaging.sendEmail({ to: subscriber.email, subject: 'Confirm your UgaMarket subscription', html, text });
}

const GENERIC_RESPONSE = { message: 'Almost done! Check your inbox and click the link to confirm your subscription.' };

async function subscribe({ email, language = 'en' }, ctx = {}) {
  const address = normalizeEmail(email);
  const lang = SUPPORTED_LANGS.has(language) ? language : 'en';
  if (!messaging.emailConfigured() && env.NODE_ENV === 'production') {
    throw new AppError('Newsletter sign-up is temporarily unavailable. Please try again later.', 503);
  }

  const existing = await prisma.newsletterSubscriber.findUnique({ where: { email: address } });
  if (existing && existing.status === 'ACTIVE') return GENERIC_RESPONSE;
  if (existing && existing.status === 'PENDING' && existing.lastConfirmSentAt && Date.now() - existing.lastConfirmSentAt.getTime() < RESEND_CONFIRM_AFTER_MS) {
    return GENERIC_RESPONSE;
  }

  const token = randomToken();
  const data = {
    status: 'PENDING',
    confirmTokenHash: sha256(token),
    confirmTokenExpires: new Date(Date.now() + CONFIRM_TTL_MS),
    language: lang,
    consentIp: ctx.ip || null,
    lastConfirmSentAt: new Date(),
  };
  const subscriber = existing
    ? await prisma.newsletterSubscriber.update({ where: { id: existing.id }, data })
    : await prisma.newsletterSubscriber.create({ data: { ...data, email: address, unsubscribeToken: randomToken(), source: 'FOOTER' } });

  const result = await sendConfirmation(subscriber, token);
  if (result.status === 'FAILED') {
    throw new AppError('We could not send the confirmation email. Please check the address and try again.', 502);
  }
  return { ...GENERIC_RESPONSE, ...(env.NODE_ENV !== 'production' && result.status === 'LOGGED' && { devToken: token }) };
}

async function confirm(token) {
  if (!/^[0-9a-f]{64}$/.test(String(token || ''))) throw new AppError('This confirmation link is invalid or has expired.', 400);
  const subscriber = await prisma.newsletterSubscriber.findUnique({ where: { confirmTokenHash: sha256(token) } });
  if (!subscriber || subscriber.status !== 'PENDING' || !subscriber.confirmTokenExpires || subscriber.confirmTokenExpires < new Date()) {
    throw new AppError('This confirmation link is invalid or has expired.', 400);
  }
  await prisma.newsletterSubscriber.update({
    where: { id: subscriber.id },
    data: { status: 'ACTIVE', confirmedAt: new Date(), confirmTokenHash: null, confirmTokenExpires: null, unsubscribedAt: null },
  });
  return { message: 'Your subscription is confirmed. Welcome to UgaMarket news!' };
}

async function unsubscribe(token, ctx = {}) {
  if (!/^[0-9a-f]{64}$/.test(String(token || ''))) throw new AppError('This unsubscribe link is invalid.', 400);
  const subscriber = await prisma.newsletterSubscriber.findUnique({ where: { unsubscribeToken: token } });
  if (!subscriber) throw new AppError('This unsubscribe link is invalid.', 400);
  if (subscriber.status !== 'UNSUBSCRIBED') {
    await prisma.newsletterSubscriber.update({
      where: { id: subscriber.id },
      data: { status: 'UNSUBSCRIBED', unsubscribedAt: new Date(), confirmTokenHash: null, confirmTokenExpires: null },
    });
  }
  // The same address on an account: withdraw marketing consent too.
  const user = await prisma.user.findFirst({ where: { email: subscriber.email, marketingConsent: true }, select: { id: true } });
  if (user) {
    const consentService = require('./consent.service');
    await consentService.setMarketingConsent(user.id, false, { source: 'UNSUBSCRIBE_LINK', ctx, syncNewsletter: false });
  }
  return { message: 'You have been unsubscribed. You will no longer receive marketing emails from UgaMarket.' };
}

/**
 * Keep the list in step with an account's marketing consent. `client` may be
 * a transaction. Only verified emails are added.
 */
async function syncFromConsent(client, userId, granted) {
  const user = await client.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true } });
  if (!user?.email) return;
  const existing = await client.newsletterSubscriber.findUnique({ where: { email: user.email } });
  if (granted) {
    if (!user.emailVerifiedAt) return;
    if (existing) {
      if (existing.status !== 'ACTIVE') {
        await client.newsletterSubscriber.update({
          where: { id: existing.id },
          data: { status: 'ACTIVE', confirmedAt: new Date(), unsubscribedAt: null, confirmTokenHash: null, confirmTokenExpires: null, source: 'ACCOUNT' },
        });
      }
    } else {
      await client.newsletterSubscriber.create({
        data: { email: user.email, status: 'ACTIVE', confirmedAt: new Date(), unsubscribeToken: randomToken(), source: 'ACCOUNT' },
      });
    }
  } else if (existing && existing.status !== 'UNSUBSCRIBED') {
    await client.newsletterSubscriber.update({ where: { id: existing.id }, data: { status: 'UNSUBSCRIBED', unsubscribedAt: new Date() } });
  }
}

// ------------------------------------------------------------
// New-arrivals digest
// ------------------------------------------------------------
function absoluteImage(url) {
  return /^https:\/\//i.test(String(url || '')) ? url : undefined;
}

let digestRunning = false;

/** Announce products created since the last run. Returns a summary. */
async function runNewArrivalsDigest({ now = new Date() } = {}) {
  if (digestRunning) return { skipped: 'already-running' };
  digestRunning = true;
  try {
    let state = await prisma.newArrivalsDigest.findUnique({ where: { id: 1 } });
    if (!state) {
      // First run: start from now so the existing catalogue is not "new".
      await prisma.newArrivalsDigest.create({ data: { id: 1, lastAnnouncedAt: now } });
      return { products: 0, emails: 0, notifications: 0 };
    }

    const products = await prisma.product.findMany({
      where: { isActive: true, createdAt: { gt: state.lastAnnouncedAt, lte: now } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, nameEn: true, priceUgx: true, imageUrl: true, createdAt: true },
    });
    if (!products.length) return { products: 0, emails: 0, notifications: 0 };

    const newest = products.reduce((max, p) => (p.createdAt > max ? p.createdAt : max), state.lastAnnouncedAt);
    // Advance first so a crash mid-send never re-announces to everyone.
    await prisma.newArrivalsDigest.update({ where: { id: 1 }, data: { lastAnnouncedAt: newest } });

    const featured = products.slice(0, DIGEST_MAX_PRODUCTS);
    const items = featured.map((p) => ({
      name: p.nameEn || 'New product',
      price: formatUGX(p.priceUgx),
      url: shopUrl(`/product/${p.id}`),
      imageUrl: absoluteImage(p.imageUrl),
    }));
    const headline = products.length === 1 ? `New on UgaMarket: ${items[0].name}` : `${products.length} new products on UgaMarket`;

    // Email ACTIVE subscribers.
    let emails = 0;
    if (messaging.emailConfigured() || env.NODE_ENV !== 'production') {
      let cursor = null;
      for (;;) {
        const batch = await prisma.newsletterSubscriber.findMany({
          where: { status: 'ACTIVE' },
          orderBy: { id: 'asc' },
          take: 100,
          ...(cursor && { skip: 1, cursor: { id: cursor } }),
          select: { id: true, email: true, unsubscribeToken: true },
        });
        if (!batch.length) break;
        for (const sub of batch) {
          const link = unsubscribeUrl(sub.unsubscribeToken);
          const { html, text } = renderEmail({
            heading: headline,
            paragraphs: ['Fresh arrivals just landed in the shop. Order today and pay a small deposit with mobile money.'],
            items,
            cta: { url: shopUrl('/catalog?sort=newest'), label: 'Shop new arrivals' },
            unsubscribeUrl: link,
          });
          const result = await messaging.sendEmail({
            to: sub.email,
            subject: headline,
            html,
            text,
            headers: { 'List-Unsubscribe': `<${link}>` },
          });
          if (result.status !== 'FAILED') emails += 1;
        }
        cursor = batch[batch.length - 1].id;
      }
    } else {
      logger.warn('[newsletter] EMAIL_PROVIDER not configured: new-arrivals emails skipped.');
    }

    // In-app notification for customers who opted in to marketing.
    const notifications = require('./notification.service');
    const consenting = await prisma.user.findMany({ where: { marketingConsent: true, isActive: true }, select: { id: true }, take: 5000 });
    for (const u of consenting) {
      await notifications.notifyCustomer(u.id, {
        type: 'NEW_ARRIVALS',
        title: headline.slice(0, 150),
        message: items
          .slice(0, 3)
          .map((i) => `${i.name} — ${i.price}`)
          .join(' · '),
        linkUrl: products.length === 1 ? `/product/${featured[0].id}` : '/catalog?sort=newest',
      });
    }
    return { products: products.length, emails, notifications: consenting.length };
  } finally {
    digestRunning = false;
  }
}

async function subscriberStats() {
  const groups = await prisma.newsletterSubscriber.groupBy({ by: ['status'], _count: { _all: true } });
  const out = { ACTIVE: 0, PENDING: 0, UNSUBSCRIBED: 0 };
  for (const g of groups) out[g.status] = g._count._all;
  return out;
}

module.exports = { subscribe, confirm, unsubscribe, syncFromConsent, runNewArrivalsDigest, subscriberStats };
