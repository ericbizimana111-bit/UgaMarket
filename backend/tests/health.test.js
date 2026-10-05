const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/db');

describe('API Foundation & Health Check', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('GET /api/health returns 200 with UP status, database connected, and UGX currency', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.status).toBe('UP');
    expect(response.body.database).toBe('connected');
    expect(response.body.currency).toBe('UGX');
    expect(response.body.service).toBe('UgaMarket API');
  });

  test('GET /api/non-existent-endpoint returns 404 with structured error', async () => {
    const response = await request(app).get('/api/non-existent-endpoint');

    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toContain('Endpoint not found');
  });
});

describe('GET /api/ping (keep-awake liveness)', () => {
  test('answers without touching the database', async () => {
    const request = require('supertest');
    const app = require('../src/app');
    const prisma = require('../src/config/db');
    const spy = jest.spyOn(prisma, '$queryRaw');
    const res = await request(app).get('/api/ping');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: 'UP' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
