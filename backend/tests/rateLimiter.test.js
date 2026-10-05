/**
 * HTTP policy middleware, exercised with the REAL limiter / CORS code:
 *  - credential brute-force limiter counts only POST attempts (never /me)
 *  - API limiter is per signed-in account, per IP otherwise
 *  - CORS: foreign origins get 403, listed and same-origin requests pass
 */
const request = require('supertest');
const express = require('express');
const { createAuthLimiter, createApiLimiter, apiLimiter, authLimiter } = require('../src/middleware/rateLimiter');
const { signCustomerToken, signAdminToken } = require('../src/services/token.service');
const app = require('../src/app');
const env = require('../src/config/env');

function appWith(limiter) {
  const a = express();
  a.use(limiter);
  a.get('/me', (req, res) => res.json({ success: true }));
  a.post('/login', (req, res) => res.json({ success: true }));
  a.get('/data', (req, res) => res.json({ success: true }));
  return a;
}

describe('rate limiting', () => {
  test('limiters are middleware', () => {
    expect(typeof apiLimiter).toBe('function');
    expect(typeof authLimiter).toBe('function');
  });

  test('auth limiter blocks repeated credential attempts with 429', async () => {
    const a = appWith(createAuthLimiter({ max: 2 }));
    expect((await request(a).post('/login')).statusCode).toBe(200);
    expect((await request(a).post('/login')).statusCode).toBe(200);
    const blocked = await request(a).post('/login');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).toMatchObject({ success: false, message: expect.stringContaining('Too many authentication attempts') });
  });

  test('session checks (GET /me) never count as login attempts', async () => {
    const a = appWith(createAuthLimiter({ max: 2 }));
    for (let i = 0; i < 10; i++) expect((await request(a).get('/me')).statusCode).toBe(200);
    expect((await request(a).post('/login')).statusCode).toBe(200);
  });

  test('signed-in shoppers on one shared IP each get their own budget', async () => {
    const a = appWith(createApiLimiter({ max: 2 }));
    const alice = signCustomerToken({ id: '11111111-1111-1111-1111-111111111111', phone: '+256772000001' });
    const bob = signCustomerToken({ id: '22222222-2222-2222-2222-222222222222', phone: '+256772000002' });
    for (const token of [alice, alice]) expect((await request(a).get('/data').set('Authorization', `Bearer ${token}`)).statusCode).toBe(200);
    expect((await request(a).get('/data').set('Authorization', `Bearer ${alice}`)).statusCode).toBe(429);
    // Bob (same IP) is unaffected by Alice using up her budget.
    expect((await request(a).get('/data').set('Authorization', `Bearer ${bob}`)).statusCode).toBe(200);
    // Staff tokens are keyed separately too.
    const staff = signAdminToken({ id: '33333333-3333-3333-3333-333333333333', email: 's@x.ug', role: 'ADMIN' });
    expect((await request(a).get('/data').set('Authorization', `Bearer ${staff}`)).statusCode).toBe(200);
  });

  test('a forged token cannot dodge the limit: it counts against the IP', async () => {
    const a = appWith(createApiLimiter({ max: 2 }));
    expect((await request(a).get('/data').set('Authorization', 'Bearer forged.1')).statusCode).toBe(200);
    expect((await request(a).get('/data').set('Authorization', 'Bearer forged.2')).statusCode).toBe(200);
    expect((await request(a).get('/data').set('Authorization', 'Bearer forged.3')).statusCode).toBe(429);
  });
});

describe('CORS policy', () => {
  test('a foreign origin is refused with 403, not a 500', async () => {
    const res = await request(app).post('/api/auth/login').set('Origin', 'https://evil.example.com').send({});
    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('a configured origin is allowed with credentials', async () => {
    const origin = env.CORS_ORIGIN.split(',')[0].trim();
    const res = await request(app).get('/api/health').set('Origin', origin);
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  test('same-origin requests work even when the domain is not listed (site + /api behind one proxy)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Host', 'shop.ugamarket.example')
      .set('Origin', 'https://shop.ugamarket.example')
      .send({ phone: '0772000000', password: 'x' });
    expect(res.statusCode).not.toBe(403);
  });

  test('preflight for a configured origin succeeds', async () => {
    const origin = env.CORS_ORIGIN.split(',')[0].trim();
    const res = await request(app).options('/api/orders').set('Origin', origin).set('Access-Control-Request-Method', 'POST');
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });
});
