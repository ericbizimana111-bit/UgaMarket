const { z } = require('zod');
const { normalizeUgandaPhone } = require('../utils/phone');

const ugandaPhoneSchema = z.string().refine((val) => {
  const result = normalizeUgandaPhone(val);
  return result.isValid;
}, {
  message: 'Invalid Uganda phone number format. Expected format: 07XXXXXXXX or +2567XXXXXXXX',
}).transform((val) => {
  const result = normalizeUgandaPhone(val);
  return result.normalized;
});

const newPasswordSchema = z
  .string({ required_error: 'Password is required' })
  .min(8, 'Password must be at least 8 characters')
  .max(100, 'Password cannot exceed 100 characters');

const otpCodeSchema = z
  .string({ required_error: 'Verification code is required' })
  .trim()
  .regex(/^\d{6}$/, 'Verification code must be a 6-digit numeric code');

const channelSchema = z.enum(['SMS', 'EMAIL'], { errorMap: () => ({ message: 'channel must be SMS or EMAIL' }) });

const optionalEmailSchema = z
  .string()
  .trim()
  .email('Invalid email address')
  .max(255)
  .optional()
  .or(z.literal(''))
  .transform((val) => (val && val.length > 0 ? val.toLowerCase() : null));

const identifierSchema = z
  .string({ required_error: 'Enter your phone number or email address' })
  .trim()
  .min(5, 'Enter your phone number or email address')
  .max(255);

// PATCH /api/auth/me — profile fields a customer may change themselves.
// Phone is the login identity and is intentionally not editable here.
const updateProfileSchema = {
  body: z
    .object({
      fullName: z.string().trim().min(2, 'Full name must be at least 2 characters').max(150).optional(),
      email: z
        .string()
        .trim()
        .email('Invalid email address')
        .max(255)
        .optional()
        .or(z.literal(''))
        .or(z.null())
        .transform((val) => (val === undefined ? undefined : val ? val.toLowerCase() : null)),
      phone: z.unknown().optional(),
      isActive: z.unknown().optional(),
      passwordHash: z.unknown().optional(),
    })
    .transform(({ fullName, email }) => ({ fullName, email })),
};

const customerRegisterSchema = {
  body: z.object({
    fullName: z
      .string({ required_error: 'Full name is required' })
      .trim()
      .min(2, 'Full name must be at least 2 characters')
      .max(150, 'Full name cannot exceed 150 characters'),
    phone: ugandaPhoneSchema,
    email: optionalEmailSchema,
    password: newPasswordSchema,
    // Sign-up verification code (required when SIGNUP_VERIFICATION_REQUIRED)
    code: otpCodeSchema.optional(),
    channel: channelSchema.optional().default('SMS'),
  }),
};

// POST /api/auth/register/start — send the sign-up code.
const signupStartSchema = {
  body: z.object({
    fullName: z.string().trim().min(2, 'Full name must be at least 2 characters').max(150).optional(),
    phone: ugandaPhoneSchema,
    email: optionalEmailSchema,
    channel: channelSchema.optional().default('SMS'),
  }),
};

const customerLoginSchema = {
  body: z.object({
    phone: ugandaPhoneSchema,
    password: z
      .string({ required_error: 'Password is required' })
      .min(1, 'Password is required'),
  }),
};

// POST /api/auth/google — `credential` is the Google ID token from Google
// Identity Services; `phone` is only sent when completing a new account.
const googleAuthSchema = {
  body: z.object({
    credential: z
      .string({ required_error: 'Google credential is required' })
      .trim()
      .min(20, 'Invalid Google credential')
      .max(4096, 'Invalid Google credential'),
    phone: ugandaPhoneSchema.optional(),
  }),
};

const adminLoginSchema = {
  body: z.object({
    email: z
      .string({ required_error: 'Email is required' })
      .trim()
      .email('Invalid email address')
      .toLowerCase(),
    password: z
      .string({ required_error: 'Password is required' })
      .min(1, 'Password is required'),
  }),
};

const otpRequestSchema = {
  body: z.object({
    phone: ugandaPhoneSchema,
  }),
};

const otpVerifySchema = {
  body: z.object({
    phone: ugandaPhoneSchema,
    code: z
      .string({ required_error: 'Verification code is required' })
      .regex(/^\d{6}$/, 'Verification code must be a 6-digit numeric code'),
  }),
};

const passwordForgotSchema = { body: z.object({ identifier: identifierSchema }) };

const passwordResetSchema = {
  body: z.object({ identifier: identifierSchema, code: otpCodeSchema, password: newPasswordSchema }),
};

const passwordChangeSchema = {
  body: z.object({
    currentPassword: z.string({ required_error: 'Enter your current password' }).min(1, 'Enter your current password').max(100),
    newPassword: newPasswordSchema,
  }),
};

const verifyStartSchema = { body: z.object({ channel: channelSchema }) };
const verifyConfirmSchema = { body: z.object({ channel: channelSchema, code: otpCodeSchema }) };

const contactChangeStartSchema = {
  body: z.object({
    channel: channelSchema,
    value: z.string({ required_error: 'Enter the new phone number or email' }).trim().min(5).max(255),
    currentPassword: z.string().max(100).optional(),
  }),
};

const contactChangeConfirmSchema = {
  body: z.object({ channel: channelSchema, value: z.string().trim().min(5).max(255), code: otpCodeSchema }),
};

const marketingConsentSchema = { body: z.object({ granted: z.boolean({ required_error: 'granted must be true or false' }) }) };

module.exports = {
  signupStartSchema,
  passwordForgotSchema,
  passwordResetSchema,
  passwordChangeSchema,
  verifyStartSchema,
  verifyConfirmSchema,
  contactChangeStartSchema,
  contactChangeConfirmSchema,
  marketingConsentSchema,
  updateProfileSchema,
  customerRegisterSchema,
  customerLoginSchema,
  googleAuthSchema,
  adminLoginSchema,
  otpRequestSchema,
  otpVerifySchema,
};
