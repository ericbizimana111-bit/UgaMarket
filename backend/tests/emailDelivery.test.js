const request = require('supertest');

// SMTP is faked: no test ever opens a real mail connection.
const mockSendMail = jest.fn();
const mockVerify = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail, verify: mockVerify })),
}));

const app = require('../src/app');
const prisma = require('../src/config/db');
const env = require('../src/config/env');
const logger = require('../src/utils/logger');
const messaging = require('../src/services/messaging');
const { validateProductionConfig, productionWarnings } = require('../src/config/envValidation');

/**
 * Email delivery: the HTTPS providers (Brevo, Resend), SMTP failure
 * diagnosis, safe logs, and the sign-up / password-reset flows when the
 * provider accepts or refuses a message.
 */

const EMAIL_KEYS = ['EMAIL_PROVIDER', 'EMAIL_FROM', 'BREVO_API_KEY', 'RESEND_API_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'];
const BREVO_KEY = 'xkeysib-test-secret-key-0000';
const SMTP_SECRET = 'abcd efgh ijkl mnop';

let seq = Math.floor(Math.random() * 9000) + 1000;
const nextPhone = () => `+2567066${String(seq++).padStart(5, '0')}`.slice(0, 13);
const created = { phones: new Set(), emails: new Set() };

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function useBrevo() {
  env.EMAIL_PROVIDER = 'BREVO';
  env.BREVO_API_KEY = BREVO_KEY;
  env.EMAIL_FROM = 'UgaMarket <ugamarket.shop@gmail.com>';
}

function useSmtp() {
  messaging.resetTransports();
  env.EMAIL_PROVIDER = 'SMTP';
  env.SMTP_HOST = 'smtp.gmail.com';
  env.SMTP_PORT = 587;
  env.SMTP_USER = 'ugamarket.shop@gmail.com';
  env.SMTP_PASS = SMTP_SECRET;
  env.EMAIL_FROM = 'UgaMarket <ugamarket.shop@gmail.com>';
}

/** Everything written to the error log during the test, as one string. */
function loggedErrors(spy) {
  return spy.mock.calls.map((args) => args.join(' ')).join('\n');
}

async function verifiedEmailCustomer() {
  const phone = nextPhone();
  const email = `reset.${Date.now()}.${seq}@example.ug`;
  created.phones.add(phone);
  created.emails.add(email);
  await prisma.user.create({
    data: {
      fullName: 'Email Reset Tester',
      phone,
      email,
      emailVerifiedAt: new Date(),
      passwordHash: '$2a$12$eXampleHashedPasswordForTestOnly999999999999999999999999',
    },
  });
  return { phone, email };
}

describe('email delivery', () => {
  const saved = {};
  const originalFetch = global.fetch;
  let errorSpy;

  beforeAll(() => {
    for (const key of EMAIL_KEYS) saved[key] = env[key];
  });

  beforeEach(() => {
    global.fetch = jest.fn();
    mockSendMail.mockReset();
    mockVerify.mockReset();
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of EMAIL_KEYS) env[key] = saved[key];
    messaging.resetTransports();
    global.fetch = originalFetch;
    errorSpy.mockRestore();
  });

  afterAll(async () => {
    const phones = [...created.phones];
    const emails = [...created.emails];
    await prisma.otpCode.deleteMany({ where: { phone: { in: [...phones, ...emails] } } });
    const users = await prisma.user.findMany({ where: { OR: [{ phone: { in: phones } }, { email: { in: emails } }] }, select: { id: true } });
    const ids = users.map((u) => u.id);
    await prisma.securityEvent.deleteMany({ where: { OR: [{ userId: { in: ids } }, { target: { in: emails.map(messaging.maskTarget) } }] } });
    await prisma.cart.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  describe('Brevo (HTTPS API)', () => {
    test('sends through the Brevo API with the verified sender', async () => {
      useBrevo();
      global.fetch.mockResolvedValue(jsonResponse(201, { messageId: '<msg-1@smtp-relay.brevo.com>' }));

      const result = await messaging.sendEmail({ to: 'amina@example.ug', subject: 'Hi', text: 'Hello', html: '<p>Hello</p>', tag: 'test' });

      expect(result).toEqual({ status: 'SENT', providerRef: '<msg-1@smtp-relay.brevo.com>' });
      const [url, init] = global.fetch.mock.calls[0];
      expect(url).toBe('https://api.brevo.com/v3/smtp/email');
      expect(init.method).toBe('POST');
      expect(init.headers['api-key']).toBe(BREVO_KEY);
      const body = JSON.parse(init.body);
      expect(body.sender).toEqual({ name: 'UgaMarket', email: 'ugamarket.shop@gmail.com' });
      expect(body.to).toEqual([{ email: 'amina@example.ug' }]);
      expect(body.htmlContent).toBe('<p>Hello</p>');
      expect(body.textContent).toBe('Hello');
    });

    test('a refused API key fails with a safe reason and no secrets in the log', async () => {
      useBrevo();
      global.fetch.mockResolvedValue(jsonResponse(401, { code: 'unauthorized', message: `Key not found: ${BREVO_KEY}` }));

      const result = await messaging.sendEmail({ to: 'amina@example.ug', subject: 'Code', text: 'Your code is 123456', html: '<b>123456</b>', tag: 'otp:PASSWORD_RESET' });

      expect(result.status).toBe('FAILED');
      expect(result.error).toBe('BREVO_HTTP_401_unauthorized');
      const log = loggedErrors(errorSpy);
      expect(log).toContain('provider=BREVO op=otp:PASSWORD_RESET');
      expect(log).toContain('to=am***@example.ug');
      expect(log).not.toContain(BREVO_KEY);
      expect(log).not.toContain('123456');
      expect(log).not.toContain('amina@example.ug');
    });

    test('a network timeout is reported as BREVO_TIMEOUT', async () => {
      useBrevo();
      const timeout = new Error('The operation was aborted due to timeout');
      timeout.name = 'TimeoutError';
      global.fetch.mockRejectedValue(timeout);

      const result = await messaging.sendEmail({ to: 'amina@example.ug', subject: 'x', text: 'x', html: 'x' });
      expect(result).toMatchObject({ status: 'FAILED', error: 'BREVO_TIMEOUT' });
    });

    test('the startup check calls the account endpoint and reports a bad key', async () => {
      useBrevo();
      global.fetch.mockResolvedValueOnce(jsonResponse(200, { email: 'owner@example.ug' }));
      await expect(messaging.verifyEmailProvider()).resolves.toEqual({ ok: true, provider: 'BREVO' });
      expect(global.fetch.mock.calls[0][0]).toBe('https://api.brevo.com/v3/account');

      global.fetch.mockResolvedValueOnce(jsonResponse(401, { code: 'unauthorized' }));
      await expect(messaging.verifyEmailProvider()).resolves.toMatchObject({ ok: false, provider: 'BREVO', reason: 'BREVO_HTTP_401_unauthorized' });
    });
  });

  describe('SMTP failures are diagnosed', () => {
    test('a blocked SMTP port (Render free) is reported as unreachable with the fix', async () => {
      useSmtp();
      mockSendMail.mockRejectedValue(Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' }));

      const result = await messaging.sendEmail({ to: 'amina@example.ug', subject: 'x', text: 'code 654321', html: 'x', tag: 'otp:SIGNUP' });

      expect(result).toMatchObject({ status: 'FAILED', error: 'SMTP_UNREACHABLE_ETIMEDOUT' });
      const log = loggedErrors(errorSpy);
      expect(log).toContain('reason=SMTP_UNREACHABLE_ETIMEDOUT');
      expect(log).toContain('smtp.gmail.com:587');
      expect(log).toContain('EMAIL_PROVIDER=BREVO');
      expect(log).not.toContain('654321');
    });

    test('rejected credentials are reported without the password', async () => {
      useSmtp();
      mockSendMail.mockRejectedValue(Object.assign(new Error(`Invalid login: 535 ${SMTP_SECRET}`), { code: 'EAUTH', responseCode: 535 }));

      const result = await messaging.sendEmail({ to: 'amina@example.ug', subject: 'x', text: 'x', html: 'x' });

      expect(result).toMatchObject({ status: 'FAILED', error: 'SMTP_AUTH_REJECTED' });
      const log = loggedErrors(errorSpy);
      expect(log).toContain('App Password');
      expect(log).not.toContain(SMTP_SECRET);
    });

    test('a working SMTP server sends the message', async () => {
      useSmtp();
      mockSendMail.mockResolvedValue({ accepted: ['amina@example.ug'], messageId: '<abc@gmail.com>' });
      const result = await messaging.sendEmail({ to: 'amina@example.ug', subject: 'x', text: 'x', html: 'x' });
      expect(result).toEqual({ status: 'SENT', providerRef: '<abc@gmail.com>' });
      expect(mockSendMail.mock.calls[0][0]).toMatchObject({ from: env.EMAIL_FROM, to: 'amina@example.ug' });
    });
  });

  describe('sign-up and password-reset emails', () => {
    test('sign-up sends the code by email through the provider', async () => {
      useBrevo();
      global.fetch.mockResolvedValue(jsonResponse(201, { messageId: 'm-1' }));
      const phone = nextPhone();
      const email = `signup.${Date.now()}@example.ug`;
      created.phones.add(phone);
      created.emails.add(email);

      const res = await request(app).post('/api/auth/register/start').send({ phone, email });

      expect(res.statusCode).toBe(200);
      expect(res.body.data.channel).toBe('EMAIL');
      expect(res.body.data.devCode).toBeUndefined(); // a real provider delivered it
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.to).toEqual([{ email }]);
      expect(body.textContent).toMatch(/\b\d{6}\b/);
      const record = await prisma.otpCode.findFirst({ where: { phone: email, purpose: 'SIGNUP' } });
      expect(record.deliveryStatus).toBe('SENT');
    });

    test('sign-up tells the customer when the email could not be sent', async () => {
      useSmtp();
      mockSendMail.mockRejectedValue(Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' }));
      const phone = nextPhone();
      const email = `signupfail.${Date.now()}@example.ug`;
      created.phones.add(phone);
      created.emails.add(email);

      const res = await request(app).post('/api/auth/register/start').send({ phone, email });

      expect(res.statusCode).toBe(502);
      expect(res.body.errors[0].code).toBe('OTP_DELIVERY_FAILED');
      expect(res.body.message).not.toMatch(/phone/i);
      // The unsent code does not block an immediate retry.
      expect(await prisma.otpCode.count({ where: { phone: email } })).toBe(0);
    });

    test('password reset emails the code to the verified address', async () => {
      useBrevo();
      global.fetch.mockResolvedValue(jsonResponse(201, { messageId: 'm-2' }));
      const { email } = await verifiedEmailCustomer();

      const res = await request(app).post('/api/auth/password/forgot').send({ identifier: email });

      expect(res.statusCode).toBe(200);
      expect(res.body.message).toContain('If an account matches');
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.to).toEqual([{ email }]);
      expect(body.subject).toMatch(/password/i);
      expect(body.textContent).toMatch(/\b\d{6}\b/);
    });

    test('password reset by phone number emails the account address', async () => {
      useBrevo();
      global.fetch.mockResolvedValue(jsonResponse(201, { messageId: 'm-3' }));
      const { phone, email } = await verifiedEmailCustomer();

      const res = await request(app).post('/api/auth/password/forgot').send({ identifier: `0${phone.slice(4)}` });

      expect(res.statusCode).toBe(200);
      expect(res.body.data.sentTo).not.toContain('@');
      expect(JSON.parse(global.fetch.mock.calls[0][1].body).to).toEqual([{ email }]);
    });

    test('a provider failure during password reset stays generic but is recorded for the team', async () => {
      useBrevo();
      global.fetch.mockResolvedValue(jsonResponse(400, { code: 'invalid_parameter' }));
      const { email } = await verifiedEmailCustomer();

      const res = await request(app).post('/api/auth/password/forgot').send({ identifier: email });

      expect(res.statusCode).toBe(200); // no account enumeration
      const event = await prisma.securityEvent.findFirst({ where: { type: 'OTP_SEND_FAILED', target: messaging.maskTarget(email) }, orderBy: { id: 'desc' } });
      expect(event.metadata).toMatchObject({ purpose: 'PASSWORD_RESET', channel: 'EMAIL', reason: 'BREVO_HTTP_400_invalid_parameter' });
      expect(loggedErrors(errorSpy)).toContain('op=otp:PASSWORD_RESET');
    });

    test('unknown addresses get the same answer and no email is sent', async () => {
      useBrevo();
      const email = `nobody.${Date.now()}@example.ug`;
      created.emails.add(email);
      const res = await request(app).post('/api/auth/password/forgot').send({ identifier: email });
      expect(res.statusCode).toBe(200);
      expect(res.body.message).toContain('If an account matches');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('admin email test', () => {
    let superAdminToken;
    beforeAll(async () => {
      const login = await request(app).post('/api/admin/auth/login').send({ email: env.ADMIN_1_EMAIL, password: env.ADMIN_1_PASSWORD });
      superAdminToken = login.body.data.token;
    });

    test('reports success and the provider', async () => {
      useBrevo();
      global.fetch.mockResolvedValue(jsonResponse(201, { messageId: 'm-4' }));
      const res = await request(app)
        .post('/api/admin/settings/email-test')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ to: 'owner.test@example.ug' });
      expect(res.statusCode).toBe(200);
      expect(res.body.data).toMatchObject({ provider: 'BREVO', status: 'SENT', sentTo: 'ow***@example.ug' });
    });

    test('reports the failure reason', async () => {
      useSmtp();
      mockSendMail.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
      const res = await request(app)
        .post('/api/admin/settings/email-test')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ to: 'owner.test@example.ug' });
      expect(res.statusCode).toBe(502);
      expect(res.body.data).toMatchObject({ provider: 'SMTP', status: 'FAILED', reason: 'SMTP_UNREACHABLE_ETIMEDOUT' });
    });

    test('requires a signed-in admin', async () => {
      const res = await request(app).post('/api/admin/settings/email-test').send({});
      expect(res.statusCode).toBe(401);
    });
  });

  describe('deploy configuration', () => {
    test('BREVO needs an API key', () => {
      const problems = validateProductionConfig({ ...process.env, NODE_ENV: 'production', EMAIL_PROVIDER: 'BREVO', EMAIL_FROM: 'a@b.ug', BREVO_API_KEY: '' });
      expect(problems.join('\n')).toContain('BREVO_API_KEY');
    });

    test('SMTP on Render warns that the ports are blocked', () => {
      const previous = process.env.RENDER;
      process.env.RENDER = 'true';
      try {
        expect(productionWarnings({ EMAIL_PROVIDER: 'SMTP' }).join('\n')).toContain('block outbound SMTP');
        expect(productionWarnings({ EMAIL_PROVIDER: 'BREVO' }).join('\n')).not.toContain('block outbound SMTP');
      } finally {
        if (previous === undefined) delete process.env.RENDER;
        else process.env.RENDER = previous;
      }
    });
  });
});
