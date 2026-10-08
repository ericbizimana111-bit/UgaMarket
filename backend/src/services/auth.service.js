const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../config/db');
const { verifyGoogleCredential } = require('./googleIdentity.service');
const { normalizeUgandaPhone } = require('../utils/phone');
const { signCustomerToken } = require('./token.service');
const { AppError } = require('../middleware/errorHandler');

/**
 * Customer Authentication Service
 */

async function registerUser({ fullName, phone, email, password }) {
  const phoneResult = normalizeUgandaPhone(phone);
  if (!phoneResult.isValid) {
    throw new AppError(phoneResult.error, 400);
  }
  const normalizedPhone = phoneResult.normalized;

  // Check if phone number already registered
  const existingPhone = await prisma.user.findUnique({
    where: { phone: normalizedPhone },
  });
  if (existingPhone) {
    throw new AppError('A user with this phone number already exists', 409);
  }

  // Check if email already registered (if provided)
  const normalizedEmail = email && email.trim().length > 0 ? email.trim().toLowerCase() : null;
  if (normalizedEmail) {
    const existingEmail = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existingEmail) {
      throw new AppError('A user with this email already exists', 409);
    }
  }

  // Hash password using 12 salt rounds
  const salt = await bcrypt.genSalt(12);
  const passwordHash = await bcrypt.hash(password, salt);

  // Create user and initialize empty cart
  const user = await prisma.user.create({
    data: {
      fullName: fullName.trim(),
      phone: normalizedPhone,
      email: normalizedEmail,
      passwordHash,
      cart: {
        create: {},
      },
    },
    select: {
      id: true,
      fullName: true,
      phone: true,
      email: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const token = signCustomerToken(user);

  return {
    user,
    token,
  };
}

async function loginUser({ phone, password }) {
  const phoneResult = normalizeUgandaPhone(phone);
  if (!phoneResult.isValid) {
    // Generic error to prevent enumeration
    throw new AppError('Invalid phone number or password', 401);
  }
  const normalizedPhone = phoneResult.normalized;

  const user = await prisma.user.findUnique({
    where: { phone: normalizedPhone },
  });

  // Generic credential error whether user doesn't exist or is inactive
  if (!user || !user.isActive) {
    throw new AppError('Invalid phone number or password', 401);
  }

  const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
  if (!isPasswordValid) {
    throw new AppError('Invalid phone number or password', 401);
  }

  // Never return passwordHash
  const safeUser = {
    id: user.id,
    fullName: user.fullName,
    phone: user.phone,
    email: user.email,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };

  const token = signCustomerToken(safeUser);

  return {
    user: safeUser,
    token,
  };
}

const SAFE_USER_SELECT = {
  id: true,
  fullName: true,
  phone: true,
  email: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
};

function codedError(message, statusCode, code) {
  return new AppError(message, statusCode, [{ code, message }]);
}

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
 *  - New Google account with `phone` → account created and signed in.
 *
 * An existing account is never linked by email: UgaMarket emails are not
 * verified (customers can type any address), so auto-linking would let
 * someone pre-register a victim's email and later share their account.
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
  // sign-in stays impossible unless the customer later sets one.
  const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
  const user = await prisma.user.create({
    data: {
      fullName,
      phone: phoneResult.normalized,
      email: profile.email,
      googleId: profile.sub,
      passwordHash,
      cart: { create: {} },
    },
    select: SAFE_USER_SELECT,
  });

  return { user, token: signCustomerToken(user), created: true };
}

async function getUserById(id) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      fullName: true,
      phone: true,
      email: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!user || !user.isActive) {
    throw new AppError('User not found or account is inactive', 401);
  }

  return user;
}

module.exports = {
  registerUser,
  loginUser,
  signInWithGoogle,
  getUserById,
};
