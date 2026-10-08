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
} = require('../validators/auth.validator');

// Customer registration
router.post('/register', validateRequest(customerRegisterSchema), authController.register);

// Customer login
router.post('/login', validateRequest(customerLoginSchema), authController.login);

// "Continue with Google" (sign in, or sign up with a phone number)
router.post('/google', validateRequest(googleAuthSchema), authController.googleSignIn);

// OTP request and verification endpoints
router.post('/otp/request', validateRequest(otpRequestSchema), authController.requestOtp);
router.post('/otp/verify', validateRequest(otpVerifySchema), authController.verifyOtp);

// Authenticated customer profile
router.get('/me', authenticateCustomer, authController.getMe);
router.patch('/me', authenticateCustomer, validateRequest(updateProfileSchema), authController.updateMe);

module.exports = router;
