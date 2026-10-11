const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/db');
const env = require('../src/config/env');
const otpService = require('../src/services/otp.service');

/**
 * One-time codes: storage, expiry, attempt limits, cooldowns, single use,
 * verified sign-up, enumeration-safe password reset, contact changes and
 * session revocation.
 */

// Unique test destinations (+25670xxxxxxx) so cooldowns never collide.
let seq = Math.floor(Math.random() * 9000) + 1000;
const nextPhone = () => `+2567055${String(seq++).padStart(5, '0')}`.slice(0, 13);
const localOf = (phone) => `0${phone.slice(4)}`;
const created = { phones: new Set(), emails: new Set() };

async function clearCooldown(target) {
  // Simulate the cooldown passing by back-dating previous codes.
  await prisma.otpCode.updateMany({ where: { phone: target }, data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });
}

async function registerVerified({ phone = nextPhone(), email, password = 'StrongPass123' } = {}) {
  created.phones.add(phone);
  if (email) created.emails.add(email);
  const start = await request(app).post('/api/auth/register/start').send({ phone, email, channel: 'SMS' });
  expect(start.statusCode).toBe(200);
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ fullName: 'Otp Tester', phone, email, password, code: start.body.data.devCode, channel: 'SMS' });
  expect(reg.statusCode).toBe(201);
  return { phone, email, password, token: reg.body.data.token, user: reg.body.data.user };
}

describe('OTP verification system', () => {
  const originalRequired = env.SIGNUP_VERIFICATION_REQUIRED;

  beforeAll(() => {
    env.SIGNUP_VERIFICATION_REQUIRED = true;
  });

  afterAll(async () => {
    env.SIGNUP_VERIFICATION_REQUIRED = originalRequired;
    const phones = [...created.phones];
    const emails = [...created.emails];
    await prisma.otpCode.deleteMany({ where: { phone: { in: [...phones, ...emails] } } });
    const users = await prisma.user.findMany({ where: { OR: [{ phone: { in: phones } }, { email: { in: emails } }] }, select: { id: true } });
    const ids = users.map((u) => u.id);
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.securityEvent.deleteMany({ where: { userId: { in: ids } } });
    await prisma.cart.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  describe('service layer', () => {
    test('codes are stored only as a keyed hash, never in plaintext', async () => {
      const phone = nextPhone();
      created.phones.add(phone);
      const result = await otpService.issueOtp({ purpose: 'VERIFY_PHONE', channel: 'SMS', target: phone });
      expect(result.devCode).toMatch(/^\d{6}$/);
      expect(result.expiresInSeconds).toBe(env.OTP_TTL_MINUTES * 60);

      const record = await prisma.otpCode.findFirst({ where: { phone, consumed: false } });
      expect(record.codeHash).not.toContain(result.devCode);
      expect(record.codeHash).toBe(otpService.hashCode('VERIFY_PHONE', phone, result.devCode));
      expect(record.deliveryStatus).toBe('SENT');
    });

    test('a correct code verifies once and cannot be replayed', async () => {
      const phone = nextPhone();
      created.phones.add(phone);
      const { devCode } = await otpService.issueOtp({ purpose: 'VERIFY_PHONE', channel: 'SMS', target: phone });
      await expect(otpService.verifyOtpCode({ purpose: 'VERIFY_PHONE', target: phone, code: devCode })).resolves.toBeDefined();
      await expect(otpService.verifyOtpCode({ purpose: 'VERIFY_PHONE', target: phone, code: devCode })).rejects.toThrow('Invalid or expired verification code');
    });

    test('a code is bound to its purpose', async () => {
      const phone = nextPhone();
      created.phones.add(phone);
      const { devCode } = await otpService.issueOtp({ purpose: 'SIGNUP', channel: 'SMS', target: phone });
      await expect(otpService.verifyOtpCode({ purpose: 'PASSWORD_RESET', target: phone, code: devCode })).rejects.toThrow('Invalid or expired');
    });

    test('expired codes are rejected', async () => {
      const phone = nextPhone();
      created.phones.add(phone);
      const { devCode } = await otpService.issueOtp({ purpose: 'VERIFY_PHONE', channel: 'SMS', target: phone });
      await prisma.otpCode.updateMany({ where: { phone }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await expect(otpService.verifyOtpCode({ purpose: 'VERIFY_PHONE', target: phone, code: devCode })).rejects.toThrow('Invalid or expired');
    });

    test('wrong guesses are limited, then the code is locked', async () => {
      const phone = nextPhone();
      created.phones.add(phone);
      const { devCode } = await otpService.issueOtp({ purpose: 'VERIFY_PHONE', channel: 'SMS', target: phone });
      const wrong = devCode === '000000' ? '111111' : '000000';
      for (let i = 0; i < env.OTP_MAX_ATTEMPTS - 1; i++) {
        await expect(otpService.verifyOtpCode({ purpose: 'VERIFY_PHONE', target: phone, code: wrong })).rejects.toThrow('Invalid verification code');
      }
      await expect(otpService.verifyOtpCode({ purpose: 'VERIFY_PHONE', target: phone, code: wrong })).rejects.toThrow('Too many incorrect attempts');
      // Even the right code no longer works.
      await expect(otpService.verifyOtpCode({ purpose: 'VERIFY_PHONE', target: phone, code: devCode })).rejects.toThrow('Invalid or expired');
    });

    test('a resend cooldown applies, and a new code voids the old one', async () => {
      const phone = nextPhone();
      created.phones.add(phone);
      const first = await otpService.issueOtp({ purpose: 'VERIFY_PHONE', channel: 'SMS', target: phone });
      await expect(otpService.issueOtp({ purpose: 'VERIFY_PHONE', channel: 'SMS', target: phone })).rejects.toThrow(/Please wait/);

      await clearCooldown(phone);
      const second = await otpService.issueOtp({ purpose: 'VERIFY_PHONE', channel: 'SMS', target: phone });
      if (first.devCode !== second.devCode) {
        await expect(otpService.verifyOtpCode({ purpose: 'VERIFY_PHONE', target: phone, code: first.devCode })).rejects.toThrow();
      }
      await expect(otpService.verifyOtpCode({ purpose: 'VERIFY_PHONE', target: phone, code: second.devCode })).resolves.toBeDefined();
    });

    test('hourly send cap per destination', async () => {
      const phone = nextPhone();
      created.phones.add(phone);
      for (let i = 0; i < env.OTP_MAX_SENDS_PER_HOUR; i++) {
        await prisma.otpCode.create({
          data: { phone, purpose: 'VERIFY_PHONE', codeHash: 'x', expiresAt: new Date(), consumed: true, createdAt: new Date(Date.now() - 10 * 60 * 1000) },
        });
      }
      await expect(otpService.issueOtp({ purpose: 'VERIFY_PHONE', channel: 'SMS', target: phone })).rejects.toThrow(/Too many codes/);
    });
  });

  describe('verified sign-up', () => {
    test('an account cannot be created without the code', async () => {
      const phone = nextPhone();
      created.phones.add(phone);
      const res = await request(app).post('/api/auth/register').send({ fullName: 'No Code', phone, password: 'StrongPass123' });
      expect(res.statusCode).toBe(400);
      expect(await prisma.user.findUnique({ where: { phone } })).toBeNull();
    });

    test('a wrong code does not create the account', async () => {
      const phone = nextPhone();
      created.phones.add(phone);
      const start = await request(app).post('/api/auth/register/start').send({ phone });
      const wrong = start.body.data.devCode === '000000' ? '111111' : '000000';
      const res = await request(app).post('/api/auth/register').send({ fullName: 'Wrong Code', phone, password: 'StrongPass123', code: wrong });
      expect(res.statusCode).toBe(400);
      expect(await prisma.user.findUnique({ where: { phone } })).toBeNull();
    });

    test('SMS verification marks ONLY the phone as verified', async () => {
      const email = `otp.${Date.now()}@example.ug`;
      const { phone, user } = await registerVerified({ email });
      const db = await prisma.user.findUnique({ where: { phone } });
      expect(db.phoneVerifiedAt).not.toBeNull();
      expect(db.emailVerifiedAt).toBeNull();
      expect(user.phoneVerifiedAt).toBeTruthy();
    });

    test('email-channel sign-up verifies only the email', async () => {
      const phone = nextPhone();
      const email = `otp.mail.${Date.now()}@example.ug`;
      created.phones.add(phone);
      created.emails.add(email);
      const start = await request(app).post('/api/auth/register/start').send({ phone, email, channel: 'EMAIL' });
      expect(start.statusCode).toBe(200);
      const reg = await request(app)
        .post('/api/auth/register')
        .send({ fullName: 'Mail Tester', phone, email, password: 'StrongPass123', code: start.body.data.devCode, channel: 'EMAIL' });
      expect(reg.statusCode).toBe(201);
      const db = await prisma.user.findUnique({ where: { phone } });
      expect(db.emailVerifiedAt).not.toBeNull();
      expect(db.phoneVerifiedAt).toBeNull();
    });

    test('requesting a code for a registered phone looks identical and yields no usable code', async () => {
      const { phone } = await registerVerified();
      await clearCooldown(phone);
      const res = await request(app).post('/api/auth/register/start').send({ phone: localOf(phone) });
      expect(res.statusCode).toBe(200);
      expect(res.body.message).toContain('Verification code sent');
      expect(res.body.data.devCode).toBeUndefined();
      const usable = await prisma.otpCode.count({ where: { phone, purpose: 'SIGNUP', consumed: false } });
      expect(usable).toBe(0);
    });
  });

  describe('password recovery', () => {
    test('unknown accounts get the same generic answer', async () => {
      const phone = nextPhone();
      created.phones.add(phone);
      const res = await request(app).post('/api/auth/password/forgot').send({ identifier: localOf(phone) });
      expect(res.statusCode).toBe(200);
      expect(res.body.message).toContain('If an account matches');
      expect(res.body.data.devCode).toBeUndefined();
    });

    test('an unverified email cannot be used for recovery', async () => {
      const email = `unverified.${Date.now()}@example.ug`;
      await registerVerified({ email });
      const res = await request(app).post('/api/auth/password/forgot').send({ identifier: email });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.devCode).toBeUndefined();
    });

    test('reset by SMS changes the password and signs out other sessions', async () => {
      const { phone, token } = await registerVerified();
      const forgot = await request(app).post('/api/auth/password/forgot').send({ identifier: localOf(phone) });
      const code = forgot.body.data.devCode;
      expect(code).toMatch(/^\d{6}$/);

      // Token-revocation works at second precision: ensure a new second.
      await new Promise((r) => setTimeout(r, 1100));
      const reset = await request(app).post('/api/auth/password/reset').send({ identifier: phone, code, password: 'BrandNewPass456' });
      expect(reset.statusCode).toBe(200);
      expect(reset.body.data.token).toBeDefined();

      const oldSession = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
      expect(oldSession.statusCode).toBe(401);
      const newSession = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${reset.body.data.token}`);
      expect(newSession.statusCode).toBe(200);

      const login = await request(app).post('/api/auth/login').send({ phone, password: 'BrandNewPass456' });
      expect(login.statusCode).toBe(200);
      // The code cannot be reused.
      const again = await request(app).post('/api/auth/password/reset').send({ identifier: phone, code, password: 'AnotherPass789' });
      expect(again.statusCode).toBe(400);
    });
  });

  describe('signed-in contact changes', () => {
    test('verify a newly added email with a code', async () => {
      const { token } = await registerVerified();
      const email = `added.${Date.now()}@example.ug`;
      created.emails.add(email);
      const patch = await request(app).patch('/api/auth/me').set('Authorization', `Bearer ${token}`).send({ email });
      expect(patch.statusCode).toBe(200);
      expect(patch.body.data.user.emailVerifiedAt).toBeNull();

      const start = await request(app).post('/api/auth/verify/start').set('Authorization', `Bearer ${token}`).send({ channel: 'EMAIL' });
      expect(start.statusCode).toBe(200);
      const confirm = await request(app)
        .post('/api/auth/verify/confirm')
        .set('Authorization', `Bearer ${token}`)
        .send({ channel: 'EMAIL', code: start.body.data.devCode });
      expect(confirm.statusCode).toBe(200);
      expect(confirm.body.data.user.emailVerifiedAt).toBeTruthy();
    });

    test('an existing email cannot be changed without a code', async () => {
      const email = `locked.${Date.now()}@example.ug`;
      const { token } = await registerVerified({ email });
      const res = await request(app).patch('/api/auth/me').set('Authorization', `Bearer ${token}`).send({ email: 'other@example.ug' });
      expect(res.statusCode).toBe(400);
    });

    test('changing the phone needs the current password and a code sent to the new number', async () => {
      const { token, password } = await registerVerified();
      const newPhone = nextPhone();
      created.phones.add(newPhone);

      const noPassword = await request(app)
        .post('/api/auth/contact/change/start')
        .set('Authorization', `Bearer ${token}`)
        .send({ channel: 'SMS', value: newPhone, currentPassword: 'wrong-password' });
      expect(noPassword.statusCode).toBe(400);

      const start = await request(app)
        .post('/api/auth/contact/change/start')
        .set('Authorization', `Bearer ${token}`)
        .send({ channel: 'SMS', value: localOf(newPhone), currentPassword: password });
      expect(start.statusCode).toBe(200);
      const confirm = await request(app)
        .post('/api/auth/contact/change/confirm')
        .set('Authorization', `Bearer ${token}`)
        .send({ channel: 'SMS', value: newPhone, code: start.body.data.devCode });
      expect(confirm.statusCode).toBe(200);
      expect(confirm.body.data.user.phone).toBe(newPhone);
      expect(confirm.body.data.user.phoneVerifiedAt).toBeTruthy();
    });
  });

  describe('legacy endpoints', () => {
    test('POST /api/auth/otp/request + /verify still work for phone verification', async () => {
      const phone = nextPhone();
      created.phones.add(phone);
      const reqRes = await request(app).post('/api/auth/otp/request').send({ phone: localOf(phone) });
      expect(reqRes.statusCode).toBe(200);
      expect(reqRes.body.message).toContain('Verification code sent');
      const verifyRes = await request(app).post('/api/auth/otp/verify').send({ phone: localOf(phone), code: reqRes.body.devCode });
      expect(verifyRes.statusCode).toBe(200);
      expect(verifyRes.body.message).toContain('verified');
    });

    test('invalid phone formats are rejected', async () => {
      const res = await request(app).post('/api/auth/otp/request').send({ phone: '12345' });
      expect(res.statusCode).toBe(400);
    });
  });
});
