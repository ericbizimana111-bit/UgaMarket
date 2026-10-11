const express = require('express');
const router = express.Router();

const authController = require('../controllers/auth.controller');
const validateRequest = require('../middleware/requestValidator');
const { authenticateCustomer } = require('../middleware/auth');
const {
  customerRegisterSchema,
  customerLoginSchema,
  googleAuthSchema,
  otpRequestSchema,
  otpVerifySchema,
  updateProfileSchema,
  signupStartSchema,
  passwordForgotSchema,
  passwordResetSchema,
  passwordChangeSchema,
  verifyStartSchema,
  verifyConfirmSchema,
  contactChangeStartSchema,
  contactChangeConfirmSchema,
  marketingConsentSchema,
} = require('../validators/auth.validator');

// Which verification channels are available (public)
router.get('/verification-config', authController.getVerificationConfig);

// Customer registration: send the code, then create the account with it
router.post('/register/start', validateRequest(signupStartSchema), authController.startSignup);
router.post('/register', validateRequest(customerRegisterSchema), authController.register);

// Customer login
router.post('/login', validateRequest(customerLoginSchema), authController.login);

// "Continue with Google" (sign in, or sign up with a phone number)
router.post('/google', validateRequest(googleAuthSchema), authController.googleSignIn);

// Password recovery (responses never reveal whether an account exists)
router.post('/password/forgot', validateRequest(passwordForgotSchema), authController.forgotPassword);
router.post('/password/reset', validateRequest(passwordResetSchema), authController.resetPassword);

// Legacy phone verification endpoints
router.post('/otp/request', validateRequest(otpRequestSchema), authController.requestOtp);
router.post('/otp/verify', validateRequest(otpVerifySchema), authController.verifyOtp);

// Authenticated customer profile & security
router.get('/me', authenticateCustomer, authController.getMe);
router.patch('/me', authenticateCustomer, validateRequest(updateProfileSchema), authController.updateMe);
router.post('/verify/start', authenticateCustomer, validateRequest(verifyStartSchema), authController.startVerification);
router.post('/verify/confirm', authenticateCustomer, validateRequest(verifyConfirmSchema), authController.confirmVerification);
router.post('/contact/change/start', authenticateCustomer, validateRequest(contactChangeStartSchema), authController.startContactChange);
router.post('/contact/change/confirm', authenticateCustomer, validateRequest(contactChangeConfirmSchema), authController.confirmContactChange);
router.post('/password/change', authenticateCustomer, validateRequest(passwordChangeSchema), authController.changePassword);
router.get('/consents', authenticateCustomer, authController.getConsents);
router.put('/consents/marketing', authenticateCustomer, validateRequest(marketingConsentSchema), authController.setMarketingConsent);

module.exports = router;
