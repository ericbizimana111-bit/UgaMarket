const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../config/db');
const env = require('../config/env');
const { verifyGoogleCredential } = require('./googleIdentity.service');
const { normalizeUgandaPhone } = require('../utils/phone');
const { signCustomerToken } = require('./token.service');
const { AppError } = require('../middleware/errorHandler');
const otp = require('./otp.service');
const { SECURITY_EVENTS, recordSecurityEvent } = require('./securityEvent.service');

/**
 * Customer Authentication Service
 *
 * Contact verification model:
 *  - Sign-up: the customer proves ownership of their phone (SMS) or email
 *    (EMAIL) with a code BEFORE the account exists. Only the verified method
 *    is marked verified; the other stays unverified until checked separately.
 *  - Google sign-up: Google has verified the email.
 *  - Password reset: a code sent to the phone or a VERIFIED email. Responses
 *    never reveal whether an account exists. A reset signs out every device.
 *  - Changing email/phone: code sent to the NEW destination; a phone change
 *    also needs the current password.
 */

const SAFE_USER_SELECT = {
  id: true,
  fullName: true,
  phone: true,
  email: true,
  isActive: true,
  emailVerifiedAt: true,
  phoneVerifiedAt: true,
  marketingConsent: true,
  createdAt: true,
  updatedAt: true,
};

const GENERIC_EXISTS_MESSAGE =
  'An account with these details already exists. Please sign in, or reset your password if you have forgotten it.';

function codedError(message, statusCode, code) {
  const err = new AppError(message, statusCode, [{ code, message }]);
  err.code = code;
  return err;
}

function normalizeEmail(email) {
  return email && String(email).trim().length > 0 ? String(email).trim().toLowerCase() : null;
}

function requirePhone(phone) {
  const result = normalizeUgandaPhone(phone);
  if (!result.isValid) throw new AppError(result.error, 400);
  return result.normalized;
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

/** Second-precision timestamp so tokens signed right after a change stay valid. */
function passwordChangeInstant() {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

function shopUrl(path = '') {
  return `${String(env.FRONTEND_URL || '').replace(/\/$/, '')}${path}`;
}

// ------------------------------------------------------------
// Sign-up
// ------------------------------------------------------------

/**
 * Step 1: send a sign-up code to the chosen channel.
 * Always answers the same way; if the destination already belongs to an
 * account, the owner gets a "you already have an account" notice instead of
 * a code (nothing tells the requester).
 */
async function startSignup({ phone, email, channel = 'SMS' }, ctx = {}) {
  const normalizedPhone = requirePhone(phone);
  const normalizedEmail = normalizeEmail(email);
  if (channel === 'EMAIL' && !normalizedEmail) {
    throw new AppError('Enter your email address to receive the code by email.', 400);
  }
  const target = channel === 'EMAIL' ? normalizedEmail : normalizedPhone;

  const [phoneOwner, emailOwner] = await Promise.all([
    prisma.user.findUnique({ where: { phone: normalizedPhone }, select: { id: true } }),
    normalizedEmail ? prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } }) : null,
  ]);

  let decoy = false;
  if (channel === 'SMS' && phoneOwner) {
    decoy = {
      notice: {
        sms: `UgaMarket: someone tried to create a new account with this number, but you already have one. Sign in or reset your password at ${shopUrl('/login')}. If this wasn't you, ignore this message.`,
      },
    };
  } else if (channel === 'EMAIL' && emailOwner) {
    decoy = {
      notice: {
        emailSubject: 'You already have a UgaMarket account',
        emailHeading: 'You already have an account',
        emailParagraphs: [
          'Someone tried to create a new UgaMarket account with this email address, but an account already uses it.',
          "If this was you, sign in or reset your password. If it wasn't you, you can ignore this email.",
        ],
        cta: { url: shopUrl('/login'), label: 'Sign in to UgaMarket' },
      },
    };
  } else if (channel === 'EMAIL' && phoneOwner) {
    // Do not tell an arbitrary email inbox that this phone is registered.
    decoy = { notice: null };
  }

  return otp.issueOtp({ purpose: 'SIGNUP', channel, target, ctx, decoy });
}

/**
 * Step 2: create the account. When verification is required, `code` must be
 * the sign-up code sent to `channel`.
 */
async function registerUser({ fullName, phone, email, password, code, channel = 'SMS' }, ctx = {}) {
  const normalizedPhone = requirePhone(phone);
  const normalizedEmail = normalizeEmail(email);

  let verified = null;
  if (env.SIGNUP_VERIFICATION_REQUIRED || code) {
    if (!code) {
      throw codedError('Enter the verification code we sent you to finish creating your account.', 400, 'OTP_REQUIRED');
    }
    if (channel === 'EMAIL' && !normalizedEmail) throw new AppError('Email address is required for email verification', 400);
    const target = channel === 'EMAIL' ? normalizedEmail : normalizedPhone;
    await otp.verifyOtpCode({ purpose: 'SIGNUP', target, code, ctx });
    verified = channel;
  }

  const [existingPhone, existingEmail] = await Promise.all([
    prisma.user.findUnique({ where: { phone: normalizedPhone }, select: { id: true } }),
    normalizedEmail ? prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } }) : null,
  ]);
  if (existingPhone || existingEmail) {
    throw new AppError(GENERIC_EXISTS_MESSAGE, 409);
  }

  const now = new Date();
  const user = await prisma.user.create({
    data: {
      fullName: fullName.trim(),
      phone: normalizedPhone,
      email: normalizedEmail,
      passwordHash: await hashPassword(password),
      phoneVerifiedAt: verified === 'SMS' ? now : null,
      emailVerifiedAt: verified === 'EMAIL' ? now : null,
      cart: { create: {} },
    },
    select: SAFE_USER_SELECT,
  });

  await recordSecurityEvent({
    userId: user.id,
    type: SECURITY_EVENTS.REGISTERED,
    target: verified === 'EMAIL' ? normalizedEmail : normalizedPhone,
    ctx,
    metadata: { verifiedBy: verified || 'NONE' },
  });

  return { user, token: signCustomerToken(user) };
}

async function loginUser({ phone, password }) {
  const phoneResult = normalizeUgandaPhone(phone);
  if (!phoneResult.isValid) {
    // Generic error to prevent enumeration
    throw new AppError('Invalid phone number or password', 401);
  }

  const user = await prisma.user.findUnique({
    where: { phone: phoneResult.normalized },
    select: { ...SAFE_USER_SELECT, passwordHash: true },
  });

  // Same work and message whether or not the account exists.
  const hash = user ? user.passwordHash : '$2a$12$C6UzMDM.H6dfI/f/IKcEeO5q1xQ9u7tQ3sXGQ8f1QwGQh8qD8b4ri';
  const isPasswordValid = await bcrypt.compare(password, hash);
  if (!user || !user.isActive || !isPasswordValid) {
    throw new AppError('Invalid phone number or password', 401);
  }

  const { passwordHash, ...safeUser } = user;
  return { user: safeUser, token: signCustomerToken(safeUser) };
}

// ------------------------------------------------------------
// Google
// ------------------------------------------------------------

/** Display name from the Google profile, falling back to the email's local part. */
function googleDisplayName(profile) {
  const name = (profile.name || '').replace(/\s+/g, ' ').trim();
  const fallback = profile.email ? profile.email.split('@')[0] : '';
  const chosen = name.length >= 2 ? name : fallback.length >= 2 ? fallback : 'UgaMarket customer';
  return chosen.slice(0, 150);
}

/**
 * "Continue with Google" (sign in or sign up).
 *
 *  - Known Google account → signed in.
 *  - New Google account without `phone` → { needsPhone: true, profile }; no
 *    account is created yet. The storefront asks for the phone number (needed
 *    for orders and mobile money) and posts the same credential again.
 *  - New Google account with `phone` → account created and signed in. The
 *    email is verified by Google; the phone stays unverified until checked.
 *
 * An existing account is never linked by email automatically: an account's
 * email may be unverified, so auto-linking could hand it to someone else.
 */
async function signInWithGoogle({ credential, phone }) {
  const profile = await verifyGoogleCredential(credential);
  if (!profile.email || !profile.emailVerified) {
    throw codedError('Your Google account email is not verified. Please use another sign-in method.', 401, 'GOOGLE_EMAIL_UNVERIFIED');
  }

  const linked = await prisma.user.findUnique({ where: { googleId: profile.sub }, select: SAFE_USER_SELECT });
  if (linked) {
    if (!linked.isActive) {
      throw new AppError('This account is inactive. Please contact support.', 401);
    }
    return { user: linked, token: signCustomerToken(linked), created: false };
  }

  const emailOwner = await prisma.user.findUnique({ where: { email: profile.email }, select: { id: true } });
  if (emailOwner) {
    throw codedError(
      'An account with this email already exists. Please sign in with your phone number and password.',
      409,
      'GOOGLE_EMAIL_IN_USE'
    );
  }

  const fullName = googleDisplayName(profile);
  if (!phone) {
    return { needsPhone: true, profile: { fullName, email: profile.email } };
  }

  const phoneResult = normalizeUgandaPhone(phone);
  if (!phoneResult.isValid) {
    throw new AppError(phoneResult.error, 400);
  }
  const phoneOwner = await prisma.user.findUnique({ where: { phone: phoneResult.normalized }, select: { id: true } });
  if (phoneOwner) {
    throw codedError(
      'This phone number already has an account. Please sign in with your phone number and password.',
      409,
      'PHONE_IN_USE'
    );
  }

  // Google-only accounts get an unguessable random password: phone+password
  // sign-in stays impossible unless the customer later sets one (reset).
  const user = await prisma.user.create({
    data: {
      fullName,
      phone: phoneResult.normalized,
      email: profile.email,
      emailVerifiedAt: new Date(),
      googleId: profile.sub,
      passwordHash: await hashPassword(crypto.randomBytes(32).toString('hex')),
      cart: { create: {} },
    },
    select: SAFE_USER_SELECT,
  });

  return { user, token: signCustomerToken(user), created: true };
}

// ------------------------------------------------------------
// Password recovery
// ------------------------------------------------------------

/** Resolve "0772..." / "+256..." / "me@x.com" to { channel, target }. */
function parseIdentifier(identifier) {
  const value = String(identifier || '').trim();
  if (value.includes('@')) {
    const email = value.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) throw new AppError('Enter a valid phone number or email address', 400);
    return { channel: 'EMAIL', target: email };
  }
  const phone = normalizeUgandaPhone(value);
  if (!phone.isValid) throw new AppError('Enter a valid phone number or email address', 400);
  return { channel: 'SMS', target: phone.normalized };
}

async function findRecoveryAccount({ channel, target }) {
  const user =
    channel === 'SMS'
      ? await prisma.user.findUnique({ where: { phone: target }, select: { id: true, isActive: true } })
      : await prisma.user.findFirst({ where: { email: target, emailVerifiedAt: { not: null } }, select: { id: true, isActive: true } });
  return user && user.isActive ? user : null;
}

/** Always resolves with the same generic answer. */
async function requestPasswordReset({ identifier }, ctx = {}) {
  const { channel, target } = parseIdentifier(identifier);
  const user = await findRecoveryAccount({ channel, target });
  await recordSecurityEvent({ userId: user?.id || null, type: SECURITY_EVENTS.PASSWORD_RESET_REQUESTED, target, ctx, metadata: { channel, matched: Boolean(user) } });
  const result = await otp.issueOtp({
    purpose: 'PASSWORD_RESET',
    channel,
    target,
    userId: user?.id || null,
    ctx,
    decoy: user ? false : { notice: null },
    swallowDeliveryErrors: true,
  });
  return {
    message: 'If an account matches these details, we have sent a reset code to it.',
    channel,
    sentTo: result.sentTo,
    expiresInSeconds: result.expiresInSeconds,
    resendInSeconds: result.resendInSeconds,
    ...(result.devCode && { devCode: result.devCode }),
  };
}

async function resetPassword({ identifier, code, password }, ctx = {}) {
  const { channel, target } = parseIdentifier(identifier);
  const record = await otp.verifyOtpCode({ purpose: 'PASSWORD_RESET', target, code, ctx });
  const user = record.userId ? await prisma.user.findUnique({ where: { id: record.userId }, select: { id: true, isActive: true, phone: true, email: true } }) : null;
  // The account must still own the destination the code was sent to.
  const stillOwns = user && (channel === 'SMS' ? user.phone === target : user.email === target);
  if (!user || !user.isActive || !stillOwns) {
    throw codedError('Invalid or expired verification code', 400, 'OTP_EXPIRED');
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(password),
      passwordChangedAt: passwordChangeInstant(),
      // Receiving the code proves ownership of that destination.
      ...(channel === 'SMS' ? { phoneVerifiedAt: new Date() } : {}),
    },
    select: SAFE_USER_SELECT,
  });
  await recordSecurityEvent({ userId: user.id, type: SECURITY_EVENTS.PASSWORD_RESET, target, ctx, metadata: { channel } });
  await securityNotice(user.id, 'Your password was changed', 'Your UgaMarket password was reset and all other devices were signed out. If this was not you, contact support immediately.');
  return { user: updated, token: signCustomerToken(updated) };
}

// ------------------------------------------------------------
// Signed-in account security
// ------------------------------------------------------------

async function loadUserForSecurity(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { ...SAFE_USER_SELECT, passwordHash: true } });
  if (!user || !user.isActive) throw new AppError('User not found or account is inactive', 401);
  return user;
}

async function checkCurrentPassword(user, currentPassword) {
  if (!currentPassword || !(await bcrypt.compare(String(currentPassword), user.passwordHash))) {
    throw codedError('Your current password is incorrect.', 400, 'WRONG_PASSWORD');
  }
}

async function securityNotice(userId, title, message) {
  // Lazy require avoids a circular import (notification -> realtime -> ...).
  const notifications = require('./notification.service');
  await notifications.notifyCustomer(userId, { type: 'SECURITY', title, message, linkUrl: '/account/security' });
}

/** Send a code to the account's CURRENT phone or email to verify it. */
async function startContactVerification(userId, { channel }, ctx = {}) {
  const user = await loadUserForSecurity(userId);
  if (channel === 'EMAIL') {
    if (!user.email) throw new AppError('Add an email address first.', 400);
    if (user.emailVerifiedAt) throw codedError('Your email is already verified.', 409, 'ALREADY_VERIFIED');
    return otp.issueOtp({ purpose: 'VERIFY_EMAIL', channel: 'EMAIL', target: user.email, userId, ctx });
  }
  if (user.phoneVerifiedAt) throw codedError('Your phone number is already verified.', 409, 'ALREADY_VERIFIED');
  return otp.issueOtp({ purpose: 'VERIFY_PHONE', channel: 'SMS', target: user.phone, userId, ctx });
}

async function confirmContactVerification(userId, { channel, code }, ctx = {}) {
  const user = await loadUserForSecurity(userId);
  const target = channel === 'EMAIL' ? user.email : user.phone;
  if (!target) throw new AppError('Add an email address first.', 400);
  await otp.verifyOtpCode({ purpose: channel === 'EMAIL' ? 'VERIFY_EMAIL' : 'VERIFY_PHONE', target, code, userId, ctx });
  const updated = await prisma.user.update({
    where: { id: userId },
    data: channel === 'EMAIL' ? { emailVerifiedAt: new Date() } : { phoneVerifiedAt: new Date() },
    select: SAFE_USER_SELECT,
  });
  await recordSecurityEvent({ userId, type: channel === 'EMAIL' ? SECURITY_EVENTS.EMAIL_VERIFIED : SECURITY_EVENTS.PHONE_VERIFIED, target, ctx });
  return { user: updated };
}

function normalizeContact(channel, value) {
  if (channel === 'EMAIL') {
    const email = normalizeEmail(value);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) throw new AppError('Enter a valid email address', 400);
    return email;
  }
  return requirePhone(value);
}

/** Send a code to a NEW email/phone. A phone change needs the current password. */
async function startContactChange(userId, { channel, value, currentPassword }, ctx = {}) {
  const user = await loadUserForSecurity(userId);
  const target = normalizeContact(channel, value);
  if (channel === 'SMS') await checkCurrentPassword(user, currentPassword);
  if ((channel === 'EMAIL' && user.email === target) || (channel === 'SMS' && user.phone === target)) {
    throw new AppError(channel === 'EMAIL' ? 'This is already your email address.' : 'This is already your phone number.', 400);
  }
  const taken = await prisma.user.findFirst({
    where: channel === 'EMAIL' ? { email: target, id: { not: userId } } : { phone: target, id: { not: userId } },
    select: { id: true },
  });
  if (taken) {
    throw new AppError(channel === 'EMAIL' ? 'This email is already used by another account' : 'This phone number is already used by another account', 409);
  }
  return otp.issueOtp({ purpose: channel === 'EMAIL' ? 'CHANGE_EMAIL' : 'CHANGE_PHONE', channel, target, userId, ctx });
}

async function confirmContactChange(userId, { channel, value, code }, ctx = {}) {
  const user = await loadUserForSecurity(userId);
  const target = normalizeContact(channel, value);
  const record = await otp.verifyOtpCode({ purpose: channel === 'EMAIL' ? 'CHANGE_EMAIL' : 'CHANGE_PHONE', target, code, userId, ctx });
  if (record.userId !== userId) throw codedError('Invalid or expired verification code', 400, 'OTP_EXPIRED');

  let updated;
  try {
    updated = await prisma.user.update({
      where: { id: userId },
      data: channel === 'EMAIL' ? { email: target, emailVerifiedAt: new Date() } : { phone: target, phoneVerifiedAt: new Date() },
      select: SAFE_USER_SELECT,
    });
  } catch (error) {
    if (error.code === 'P2002') throw new AppError('This contact is already used by another account', 409);
    throw error;
  }
  await recordSecurityEvent({
    userId,
    type: channel === 'EMAIL' ? SECURITY_EVENTS.EMAIL_CHANGED : SECURITY_EVENTS.PHONE_CHANGED,
    target,
    ctx,
    metadata: { previous: channel === 'EMAIL' ? (user.email ? require('./messaging').maskTarget(user.email) : null) : require('./messaging').maskTarget(user.phone) },
  });
  await securityNotice(
    userId,
    channel === 'EMAIL' ? 'Your email address was changed' : 'Your phone number was changed',
    channel === 'EMAIL'
      ? `Your UgaMarket email is now ${target}. If you did not make this change, contact support immediately.`
      : `Your UgaMarket phone number is now ${target}. Use it to sign in from now on. If you did not make this change, contact support immediately.`
  );
  // The phone is part of the token payload: issue a fresh one.
  return { user: updated, token: signCustomerToken(updated) };
}

async function changePassword(userId, { currentPassword, newPassword }, ctx = {}) {
  const user = await loadUserForSecurity(userId);
  await checkCurrentPassword(user, currentPassword);
  if (await bcrypt.compare(newPassword, user.passwordHash)) {
    throw new AppError('Choose a new password that is different from your current one.', 400);
  }
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword), passwordChangedAt: passwordChangeInstant() },
    select: SAFE_USER_SELECT,
  });
  await recordSecurityEvent({ userId, type: SECURITY_EVENTS.PASSWORD_CHANGED, ctx });
  await securityNotice(userId, 'Your password was changed', 'Your UgaMarket password was changed and other devices were signed out. If this was not you, reset your password and contact support.');
  return { user: updated, token: signCustomerToken(updated) };
}

async function getUserById(id) {
  const user = await prisma.user.findUnique({ where: { id }, select: SAFE_USER_SELECT });
  if (!user || !user.isActive) {
    throw new AppError('User not found or account is inactive', 401);
  }
  return user;
}

module.exports = {
  SAFE_USER_SELECT,
  startSignup,
  registerUser,
  loginUser,
  signInWithGoogle,
  requestPasswordReset,
  resetPassword,
  startContactVerification,
  confirmContactVerification,
  startContactChange,
  confirmContactChange,
  changePassword,
  getUserById,
  parseIdentifier,
};
