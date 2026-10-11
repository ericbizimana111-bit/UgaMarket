const crypto = require('crypto');
const prisma = require('../config/db');
const env = require('../config/env');
const { AppError } = require('../middleware/errorHandler');
const messaging = require('./messaging');
const { renderEmail } = require('./messaging/templates');
const { SECURITY_EVENTS, recordSecurityEvent } = require('./securityEvent.service');

/**
 * One-time verification codes (SMS or email).
 *
 *  - 6 random digits from the CSPRNG (crypto.randomInt).
 *  - Stored only as an HMAC-SHA256 keyed with a server secret, so a database
 *    leak does not reveal codes (10^6 guesses offline are useless without
 *    the key). Compared in constant time.
 *  - Bound to one destination AND one purpose: a signup code can never reset
 *    a password.
 *  - Expire after OTP_TTL_MINUTES, allow OTP_MAX_ATTEMPTS wrong guesses, are
 *    single-use (atomic consume), and issuing a new code voids older ones.
 *  - Resend cooldown per destination+purpose, hourly cap per destination and
 *    per IP address.
 *  - Decoys: when the honest answer would reveal whether an account exists,
 *    callers pass `decoy`; the response, timing and rate limiting look the
 *    same, but no usable code exists (an optional notice is sent instead).
 *  - Codes are never logged, and only returned in API responses (`devCode`)
 *    outside production when no real provider delivered them.
 */

const PURPOSES = ['SIGNUP', 'VERIFY_EMAIL', 'VERIFY_PHONE', 'PASSWORD_RESET', 'CHANGE_EMAIL', 'CHANGE_PHONE'];
const MAX_SENDS_PER_IP_PER_HOUR = 20;

const HASH_KEY = crypto
  .createHash('sha256')
  .update(env.OTP_SECRET || `otp-pepper:${env.JWT_SECRET}`)
  .digest();

function hashCode(purpose, target, code) {
  return crypto.createHmac('sha256', HASH_KEY).update(`${purpose}:${target}:${code}`).digest('hex');
}

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function codedError(message, statusCode, code, extra = {}) {
  const err = new AppError(message, statusCode, [{ code, message, ...extra }]);
  err.code = code;
  return err;
}

const SMS_TEXT = {
  SIGNUP: (code, ttl) => `UgaMarket: your verification code is ${code}. It expires in ${ttl} minutes. Never share this code.`,
  VERIFY_PHONE: (code, ttl) => `UgaMarket: your phone verification code is ${code}. It expires in ${ttl} minutes. Never share this code.`,
  VERIFY_EMAIL: (code, ttl) => `UgaMarket: your verification code is ${code}. It expires in ${ttl} minutes.`,
  PASSWORD_RESET: (code, ttl) =>
    `UgaMarket: your password reset code is ${code}. It expires in ${ttl} minutes. If you did not ask to reset your password, ignore this message.`,
  CHANGE_PHONE: (code, ttl) => `UgaMarket: use ${code} to confirm this as your new phone number. It expires in ${ttl} minutes.`,
  CHANGE_EMAIL: (code, ttl) => `UgaMarket: use ${code} to confirm your new email address. It expires in ${ttl} minutes.`,
};

const EMAIL_COPY = {
  SIGNUP: { subject: 'Your UgaMarket verification code', heading: 'Confirm your email', intro: 'Use this code to finish creating your UgaMarket account.' },
  VERIFY_EMAIL: { subject: 'Verify your email for UgaMarket', heading: 'Verify your email', intro: 'Use this code to verify your email address on UgaMarket.' },
  VERIFY_PHONE: { subject: 'Your UgaMarket verification code', heading: 'Your verification code', intro: 'Use this code to verify your UgaMarket account.' },
  PASSWORD_RESET: {
    subject: 'Reset your UgaMarket password',
    heading: 'Reset your password',
    intro: 'We received a request to reset the password of your UgaMarket account. Use this code to choose a new password.',
  },
  CHANGE_EMAIL: { subject: 'Confirm your new email address', heading: 'Confirm your new email', intro: 'Use this code to make this your UgaMarket email address.' },
  CHANGE_PHONE: { subject: 'Your UgaMarket verification code', heading: 'Confirm your new phone', intro: 'Use this code to confirm your new phone number.' },
};

async function deliver(channel, target, purpose, code) {
  const ttl = env.OTP_TTL_MINUTES;
  if (channel === 'SMS') return messaging.sendSms(target, SMS_TEXT[purpose](code, ttl));
  const copy = EMAIL_COPY[purpose];
  const { html, text } = renderEmail({
    heading: copy.heading,
    paragraphs: [copy.intro],
    code,
    footerNote: `This code expires in ${ttl} minutes. If you did not request it, you can safely ignore this email.`,
  });
  return messaging.sendEmail({ to: target, subject: copy.subject, html, text, tag: `otp:${purpose}` });
}

async function deliverNotice(channel, target, notice) {
  if (!notice) return { status: 'SUPPRESSED', providerRef: null };
  if (channel === 'SMS') return messaging.sendSms(target, notice.sms);
  const { html, text } = renderEmail({ heading: notice.emailHeading, paragraphs: notice.emailParagraphs, cta: notice.cta });
  return messaging.sendEmail({ to: target, subject: notice.emailSubject, html, text, tag: 'otp:notice' });
}

/** Is a delivery channel usable right now? (LOG only counts outside production.) */
function channelAvailable(channel) {
  // Phone codes are switched off until SMS_VERIFICATION_ENABLED=true.
  if (channel === 'SMS') return env.SMS_VERIFICATION_ENABLED && (messaging.smsConfigured() || env.NODE_ENV !== 'production');
  return messaging.emailConfigured() || env.NODE_ENV !== 'production';
}

async function enforceSendLimits({ purpose, target, ctx, userId }) {
  const now = Date.now();
  const latest = await prisma.otpCode.findFirst({
    where: { phone: target, purpose },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const cooldownMs = env.OTP_RESEND_COOLDOWN_SECONDS * 1000;
  if (latest && now - latest.createdAt.getTime() < cooldownMs) {
    const retryAfter = Math.ceil((cooldownMs - (now - latest.createdAt.getTime())) / 1000);
    throw codedError(`Please wait ${retryAfter} seconds before requesting another code.`, 429, 'OTP_COOLDOWN', { retryAfter });
  }

  const hourAgo = new Date(now - 60 * 60 * 1000);
  const [perTarget, perIp] = await Promise.all([
    prisma.otpCode.count({ where: { phone: target, createdAt: { gte: hourAgo } } }),
    ctx.ip ? prisma.otpCode.count({ where: { ipAddress: ctx.ip, createdAt: { gte: hourAgo } } }) : 0,
  ]);
  if (perTarget >= env.OTP_MAX_SENDS_PER_HOUR || perIp >= MAX_SENDS_PER_IP_PER_HOUR) {
    await recordSecurityEvent({ userId, type: SECURITY_EVENTS.OTP_RATE_LIMITED, target, ctx, metadata: { purpose } });
    throw codedError('Too many codes requested. Please try again in an hour.', 429, 'OTP_RATE_LIMITED', { retryAfter: 3600 });
  }
}

/**
 * Create and send a code.
 * @param {object} p
 * @param {'SIGNUP'|'VERIFY_EMAIL'|'VERIFY_PHONE'|'PASSWORD_RESET'|'CHANGE_EMAIL'|'CHANGE_PHONE'} p.purpose
 * @param {'SMS'|'EMAIL'} p.channel
 * @param {string} p.target           normalized phone (+256...) or lower-cased email
 * @param {string} [p.userId]
 * @param {{ip?:string,userAgent?:string}} [p.ctx]
 * @param {false|{notice?:object}} [p.decoy]  respond as usual but store no usable code
 * @param {boolean} [p.swallowDeliveryErrors] never reveal a provider failure (enumeration-sensitive flows)
 */
async function issueOtp({ purpose, channel, target, userId = null, ctx = {}, decoy = false, swallowDeliveryErrors = false }) {
  if (!PURPOSES.includes(purpose)) throw new AppError('Unsupported verification purpose', 400);
  if (channel !== 'SMS' && channel !== 'EMAIL') throw new AppError('Unsupported verification channel', 400);
  if (!channelAvailable(channel)) {
    throw codedError(
      channel === 'SMS'
        ? 'Verification codes are sent by email for now. Please use your email address.'
        : 'Email verification is temporarily unavailable. Please try again in a few minutes.',
      503,
      'OTP_CHANNEL_UNAVAILABLE'
    );
  }

  await enforceSendLimits({ purpose, target, ctx, userId });

  // Void older unused codes for the same destination + purpose.
  await prisma.otpCode.updateMany({
    where: { phone: target, purpose, consumed: false },
    data: { consumed: true, consumedAt: new Date() },
  });

  const code = generateCode();
  const expiresAt = new Date(Date.now() + env.OTP_TTL_MINUTES * 60 * 1000);
  const record = await prisma.otpCode.create({
    data: {
      phone: target,
      channel,
      purpose,
      userId,
      // A decoy stores a hash of a code nobody knows, so it can never verify.
      codeHash: hashCode(purpose, target, decoy ? crypto.randomBytes(16).toString('hex') : code),
      expiresAt,
      consumed: Boolean(decoy),
      consumedAt: decoy ? new Date() : null,
      maxAttempts: env.OTP_MAX_ATTEMPTS,
      deliveryStatus: decoy ? 'SUPPRESSED' : 'QUEUED',
      ipAddress: ctx.ip || null,
    },
  });

  const result = decoy ? await deliverNotice(channel, target, decoy.notice) : await deliver(channel, target, purpose, code);
  if (!decoy) {
    await prisma.otpCode.update({
      where: { id: record.id },
      data: { deliveryStatus: result.status === 'LOGGED' ? 'SENT' : result.status, providerRef: result.providerRef || null },
    });
  }

  if (!decoy && result.status === 'FAILED') {
    await recordSecurityEvent({ userId, type: SECURITY_EVENTS.OTP_SEND_FAILED, target, ctx, metadata: { purpose, channel, reason: result.error } });
    if (!swallowDeliveryErrors) {
      // The unsent code must not count against the customer's next attempt.
      await prisma.otpCode.delete({ where: { id: record.id } }).catch(() => {});
      throw codedError(
        channel === 'SMS'
          ? 'We could not send the SMS. Please check the number and try again, or use your email.'
          : 'We could not send the verification email right now. Please check the address and try again in a few minutes.',
        502,
        'OTP_DELIVERY_FAILED'
      );
    }
  } else if (!decoy) {
    await recordSecurityEvent({ userId, type: SECURITY_EVENTS.OTP_SENT, target, ctx, metadata: { purpose, channel } });
  }

  return {
    success: true,
    message: 'Verification code sent successfully',
    channel,
    sentTo: messaging.maskTarget(target),
    expiresInSeconds: env.OTP_TTL_MINUTES * 60,
    resendInSeconds: env.OTP_RESEND_COOLDOWN_SECONDS,
    // Development convenience only: never in production, never when a real
    // provider delivered the code, never for decoys.
    ...(env.NODE_ENV !== 'production' && !decoy && result.status === 'LOGGED' && { devCode: code }),
  };
}

/**
 * Check a code and consume it. Throws 400 (wrong/expired) or 429 (too many
 * wrong guesses). Returns the consumed record.
 */
async function verifyOtpCode({ purpose, target, code, userId = null, ctx = {} }) {
  if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    throw codedError('Enter the 6-digit verification code.', 400, 'OTP_INVALID');
  }

  const record = await prisma.otpCode.findFirst({
    where: { phone: target, purpose, consumed: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!record) {
    throw codedError('Invalid or expired verification code', 400, 'OTP_EXPIRED');
  }
  if (record.attempts >= record.maxAttempts) {
    await prisma.otpCode.update({ where: { id: record.id }, data: { consumed: true, consumedAt: new Date() } });
    throw codedError('Too many incorrect attempts. Please request a new code.', 429, 'OTP_LOCKED');
  }

  const expected = Buffer.from(record.codeHash, 'hex');
  const actual = Buffer.from(hashCode(purpose, target, code), 'hex');
  const matches = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  if (!matches) {
    const attempts = record.attempts + 1;
    const locked = attempts >= record.maxAttempts;
    await prisma.otpCode.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 }, ...(locked && { consumed: true, consumedAt: new Date() }) },
    });
    await recordSecurityEvent({
      userId: userId || record.userId,
      type: locked ? SECURITY_EVENTS.OTP_LOCKED : SECURITY_EVENTS.OTP_FAILED,
      target,
      ctx,
      metadata: { purpose, attempts },
    });
    if (locked) throw codedError('Too many incorrect attempts. Please request a new code.', 429, 'OTP_LOCKED');
    throw codedError('Invalid verification code', 400, 'OTP_INVALID', { attemptsLeft: record.maxAttempts - attempts });
  }

  // Atomic single use: two concurrent requests cannot both consume the code.
  const consumed = await prisma.otpCode.updateMany({
    where: { id: record.id, consumed: false },
    data: { consumed: true, consumedAt: new Date() },
  });
  if (consumed.count !== 1) {
    throw codedError('Invalid or expired verification code', 400, 'OTP_EXPIRED');
  }
  await recordSecurityEvent({ userId: userId || record.userId, type: SECURITY_EVENTS.OTP_VERIFIED, target, ctx, metadata: { purpose } });
  return record;
}

/** Update delivery status from a provider callback (Africa's Talking delivery report). */
async function applyDeliveryReport(providerRef, status) {
  if (!providerRef) return 0;
  const map = { Success: 'DELIVERED', Sent: 'SENT', Submitted: 'SENT', Buffered: 'SENT', Failed: 'FAILED', Rejected: 'FAILED' };
  const deliveryStatus = map[status];
  if (!deliveryStatus) return 0;
  const result = await prisma.otpCode.updateMany({ where: { providerRef: String(providerRef).slice(0, 150) }, data: { deliveryStatus } });
  return result.count;
}

// ------------------------------------------------------------
// Legacy phone-only helpers (POST /api/auth/otp/*): phone verification
// codes not tied to an account.
// ------------------------------------------------------------
async function requestOtp(phone, ctx = {}) {
  if (!channelAvailable('SMS')) throw codedError('Phone verification is coming soon. Verification codes are sent by email for now.', 503, 'SMS_DISABLED');
  return issueOtp({ purpose: 'VERIFY_PHONE', channel: 'SMS', target: phone, ctx });
}

async function verifyOtp(phone, code, ctx = {}) {
  await verifyOtpCode({ purpose: 'VERIFY_PHONE', target: phone, code, ctx });
  return { success: true };
}

module.exports = {
  PURPOSES,
  issueOtp,
  verifyOtpCode,
  applyDeliveryReport,
  channelAvailable,
  hashCode,
  requestOtp,
  verifyOtp,
};
