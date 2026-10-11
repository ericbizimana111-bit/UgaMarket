const authService = require('../services/auth.service');
const otpService = require('../services/otp.service');
const prisma = require('../config/db');
const env = require('../config/env');
const consentService = require('../services/consent.service');
const { requestContext } = require('../services/securityEvent.service');
const { AppError } = require('../middleware/errorHandler');

/** Wrap an async handler: errors go to the central error handler. */
const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

/** Public verification settings the sign-up form needs. */
const getVerificationConfig = handle(async (req, res) => {
  res.json({
    success: true,
    data: {
      signupVerificationRequired: env.SIGNUP_VERIFICATION_REQUIRED,
      channels: {
        SMS: otpService.channelAvailable('SMS'),
        EMAIL: otpService.channelAvailable('EMAIL'),
      },
      codeLength: 6,
    },
  });
});

const startSignup = handle(async (req, res) => {
  const result = await authService.startSignup(req.body, requestContext(req));
  res.json({ success: true, message: result.message, data: result });
});

const register = handle(async (req, res) => {
  const result = await authService.registerUser(req.body, requestContext(req));
  res.status(201).json({ success: true, message: 'Registration successful', data: result });
});

const login = handle(async (req, res) => {
  const result = await authService.loginUser(req.body);
  res.json({ success: true, message: 'Login successful', data: result });
});

// POST /api/auth/google — sign in / sign up with a Google ID token
const googleSignIn = handle(async (req, res) => {
  const result = await authService.signInWithGoogle(req.body);
  if (result.needsPhone) {
    return res.json({
      success: true,
      message: 'Add your phone number to finish creating your account',
      data: { needsPhone: true, profile: result.profile },
    });
  }
  res.status(result.created ? 201 : 200).json({
    success: true,
    message: result.created ? 'Registration successful' : 'Login successful',
    data: { user: result.user, token: result.token },
  });
});

// Legacy phone-verification endpoints (not tied to an account).
const requestOtp = handle(async (req, res) => {
  const result = await otpService.requestOtp(req.body.phone, requestContext(req));
  res.json({
    success: true,
    message: result.message,
    expiresInSeconds: result.expiresInSeconds,
    ...(result.devCode && { devCode: result.devCode }),
  });
});

const verifyOtp = handle(async (req, res) => {
  await otpService.verifyOtp(req.body.phone, req.body.code, requestContext(req));
  res.json({ success: true, message: 'Phone number verified successfully' });
});

// ---- Password recovery ----
const forgotPassword = handle(async (req, res) => {
  const result = await authService.requestPasswordReset(req.body, requestContext(req));
  res.json({ success: true, message: result.message, data: result });
});

const resetPassword = handle(async (req, res) => {
  const result = await authService.resetPassword(req.body, requestContext(req));
  res.json({ success: true, message: 'Your password has been reset', data: result });
});

// ---- Signed-in account ----
const getMe = handle(async (req, res) => {
  res.json({ success: true, data: { user: req.user } });
});

// PATCH /api/auth/me — update own name; an email may be ADDED here when the
// account has none (it stays unverified). Changing an existing email goes
// through the verified change flow (POST /auth/contact/change/*).
const updateMe = handle(async (req, res) => {
  const data = {};
  if (req.body.fullName !== undefined) data.fullName = req.body.fullName;
  if (req.body.email !== undefined && req.body.email !== (req.user.email || null)) {
    if (req.user.email) {
      throw new AppError('To change your email address, confirm the new address with a verification code from Account > Security.', 400);
    }
    if (req.body.email) {
      const taken = await prisma.user.findFirst({ where: { email: req.body.email, id: { not: req.user.id } }, select: { id: true } });
      if (taken) throw new AppError('This email is already used by another account', 409);
      data.email = req.body.email;
      data.emailVerifiedAt = null;
    }
  }
  const user = await prisma.user.update({ where: { id: req.user.id }, data, select: authService.SAFE_USER_SELECT });
  res.json({ success: true, message: 'Profile updated', data: { user } });
});

const startVerification = handle(async (req, res) => {
  const result = await authService.startContactVerification(req.user.id, req.body, requestContext(req));
  res.json({ success: true, message: result.message, data: result });
});

const confirmVerification = handle(async (req, res) => {
  const result = await authService.confirmContactVerification(req.user.id, req.body, requestContext(req));
  res.json({ success: true, message: req.body.channel === 'EMAIL' ? 'Email verified' : 'Phone number verified', data: result });
});

const startContactChange = handle(async (req, res) => {
  const result = await authService.startContactChange(req.user.id, req.body, requestContext(req));
  res.json({ success: true, message: result.message, data: result });
});

const confirmContactChange = handle(async (req, res) => {
  const result = await authService.confirmContactChange(req.user.id, req.body, requestContext(req));
  res.json({ success: true, message: req.body.channel === 'EMAIL' ? 'Email address updated' : 'Phone number updated', data: result });
});

const changePassword = handle(async (req, res) => {
  const result = await authService.changePassword(req.user.id, req.body, requestContext(req));
  res.json({ success: true, message: 'Password changed', data: result });
});

// ---- Marketing consent (account settings) ----
const getConsents = handle(async (req, res) => {
  res.json({ success: true, data: await consentService.getCustomerConsents(req.user.id) });
});

const setMarketingConsent = handle(async (req, res) => {
  const data = await consentService.setMarketingConsent(req.user.id, req.body.granted, { source: 'ACCOUNT', ctx: requestContext(req) });
  res.json({ success: true, message: req.body.granted ? 'You will receive offers and news' : 'You will no longer receive marketing messages', data });
});

// ---- Africa's Talking delivery reports (token-protected webhook) ----
const smsDeliveryReport = handle(async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!env.SMS_DELIVERY_REPORT_TOKEN || !safeEqual(token, env.SMS_DELIVERY_REPORT_TOKEN)) {
    throw new AppError('Not found', 404);
  }
  await otpService.applyDeliveryReport(req.body?.id, req.body?.status);
  res.json({ success: true });
});

function safeEqual(a, b) {
  const crypto = require('crypto');
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

module.exports = {
  getVerificationConfig,
  startSignup,
  register,
  login,
  googleSignIn,
  requestOtp,
  verifyOtp,
  forgotPassword,
  resetPassword,
  getMe,
  updateMe,
  startVerification,
  confirmVerification,
  startContactChange,
  confirmContactChange,
  changePassword,
  getConsents,
  setMarketingConsent,
  smsDeliveryReport,
};
