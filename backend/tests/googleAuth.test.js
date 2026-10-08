const request = require('supertest');

/**
 * "Continue with Google" — POST /api/auth/google
 *
 * Only Google's library is replaced (no network): a fake OAuth2Client accepts
 * known test tokens, and only when they are verified for OUR client ID. The
 * real googleIdentity.service, auth service, routes and database are used.
 */
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const mockTokens = new Map();

jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: async ({ idToken, audience }) => {
      const payload = mockTokens.get(idToken);
      if (!payload || audience !== 'test-client-id.apps.googleusercontent.com') {
        throw new Error('Wrong number of segments in token');
      }
      return { getPayload: () => payload };
    },
  })),
}));

const app = require('../src/app');
const prisma = require('../src/config/db');
const env = require('../src/config/env');

const run = Date.now().toString().slice(-6);
const token = (name) => `google-test-token-${name}-${run}`;
function googleUser(name, overrides = {}) {
  mockTokens.set(token(name), {
    sub: `google-sub-${name}-${run}`,
    email: `${name}.${run}@gmail.test`,
    email_verified: true,
    name: `Google ${name}`,
    ...overrides,
  });
  return token(name);
}
// +256 77 XXXXX NN — nine digits after the country code, unique per run.
const phoneRun = run.slice(-5);
const phoneFor = (n) => `+25677${phoneRun}${String(n).padStart(2, '0')}`;

describe('Continue with Google', () => {
  let previousClientId;

  beforeAll(() => {
    previousClientId = env.GOOGLE_CLIENT_ID;
    env.GOOGLE_CLIENT_ID = CLIENT_ID;
  });

  afterAll(async () => {
    env.GOOGLE_CLIENT_ID = previousClientId;
    const users = await prisma.user.findMany({ where: { email: { endsWith: `.${run}@gmail.test` } }, select: { id: true } });
    const phoneUsers = await prisma.user.findMany({ where: { phone: { startsWith: `+25677${phoneRun}` } }, select: { id: true } });
    const ids = [...new Set([...users, ...phoneUsers].map((u) => u.id))];
    await prisma.cartItem.deleteMany({ where: { cart: { userId: { in: ids } } } });
    await prisma.cart.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  const post = (body) => request(app).post('/api/auth/google').send(body);

  test('new Google user without a phone → asked for a phone, no account created yet', async () => {
    const credential = googleUser('amina');
    const res = await post({ credential });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({
      needsPhone: true,
      profile: { fullName: 'Google amina', email: `amina.${run}@gmail.test` },
    });
    expect(res.body.data.token).toBeUndefined();
    expect(await prisma.user.count({ where: { googleId: `google-sub-amina-${run}` } })).toBe(0);
  });

  test('new Google user with a phone → account created with Google identity, signed in', async () => {
    const credential = googleUser('brian');
    const res = await post({ credential, phone: phoneFor(1).replace('+256', '0') });
    expect(res.statusCode).toBe(201);
    expect(res.body.data.token).toEqual(expect.any(String));
    expect(res.body.data.user).toMatchObject({ fullName: 'Google brian', email: `brian.${run}@gmail.test`, phone: phoneFor(1) });
    expect(res.body.data.user).not.toHaveProperty('passwordHash');
    expect(res.body.data.user).not.toHaveProperty('googleId');

    const row = await prisma.user.findUnique({ where: { phone: phoneFor(1) }, include: { cart: true } });
    expect(row.googleId).toBe(`google-sub-brian-${run}`);
    expect(row.cart).not.toBeNull();

    // The token works like any customer session
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.data.token}`);
    expect(me.statusCode).toBe(200);
    expect(me.body.data.user.phone).toBe(phoneFor(1));
  });

  test('returning Google user → signed in directly (no phone needed)', async () => {
    const credential = token('brian');
    const res = await post({ credential });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.user.phone).toBe(phoneFor(1));
    expect(res.body.data.token).toEqual(expect.any(String));
    expect(await prisma.user.count({ where: { googleId: `google-sub-brian-${run}` } })).toBe(1);
  });

  test('a Google-only account cannot be used with phone + password guessing', async () => {
    const res = await request(app).post('/api/auth/login').send({ phone: phoneFor(1), password: 'Password123!' });
    expect(res.statusCode).toBe(401);
  });

  test('a phone number that already has an account is refused (PHONE_IN_USE)', async () => {
    const credential = googleUser('carol');
    const res = await post({ credential, phone: phoneFor(1) });
    expect(res.statusCode).toBe(409);
    expect(res.body.errors[0].code).toBe('PHONE_IN_USE');
  });

  test('an existing account with the same email is never auto-linked (GOOGLE_EMAIL_IN_USE)', async () => {
    const email = `dana.${run}@gmail.test`;
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ fullName: 'Dana Phone', phone: phoneFor(2), email, password: 'StrongPassword123!' });
    expect(reg.statusCode).toBe(201);

    const credential = googleUser('dana', { email });
    const res = await post({ credential, phone: phoneFor(3) });
    expect(res.statusCode).toBe(409);
    expect(res.body.errors[0].code).toBe('GOOGLE_EMAIL_IN_USE');
    const existing = await prisma.user.findUnique({ where: { email } });
    expect(existing.googleId).toBeNull();
  });

  test('a Google account with an unverified email is refused', async () => {
    const credential = googleUser('eve', { email_verified: false });
    const res = await post({ credential, phone: phoneFor(4) });
    expect(res.statusCode).toBe(401);
    expect(res.body.errors[0].code).toBe('GOOGLE_EMAIL_UNVERIFIED');
  });

  test('a forged / foreign token is rejected with 401', async () => {
    const res = await post({ credential: 'x'.repeat(40) });
    expect(res.statusCode).toBe(401);
  });

  test('a token issued for another client ID is rejected', async () => {
    const credential = googleUser('frank');
    env.GOOGLE_CLIENT_ID = 'someone-elses-client.apps.googleusercontent.com';
    try {
      const res = await post({ credential });
      expect(res.statusCode).toBe(401);
    } finally {
      env.GOOGLE_CLIENT_ID = CLIENT_ID;
    }
  });

  test('an inactive linked account cannot sign in', async () => {
    const credential = googleUser('gina');
    const created = await post({ credential, phone: phoneFor(5) });
    expect(created.statusCode).toBe(201);
    await prisma.user.update({ where: { phone: phoneFor(5) }, data: { isActive: false } });
    const res = await post({ credential });
    expect(res.statusCode).toBe(401);
  });

  test('invalid input is rejected by validation (missing credential, bad phone)', async () => {
    expect((await post({})).statusCode).toBe(400);
    expect((await post({ credential: googleUser('hana'), phone: '12345' })).statusCode).toBe(400);
  });

  test('Google sign-in not configured → 503', async () => {
    env.GOOGLE_CLIENT_ID = '';
    try {
      const res = await post({ credential: googleUser('ivan') });
      expect(res.statusCode).toBe(503);
    } finally {
      env.GOOGLE_CLIENT_ID = CLIENT_ID;
    }
  });
});
