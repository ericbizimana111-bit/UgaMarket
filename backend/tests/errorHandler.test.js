/**
 * Error responses must never leak internals (SQL, schema, file paths) to
 * clients in production, while deliberate (operational) errors keep their
 * helpful message.
 */
const request = require('supertest');
const express = require('express');
const env = require('../src/config/env');
const { AppError, errorHandler } = require('../src/middleware/errorHandler');

function appThrowing(err) {
  const a = express();
  a.get('/x', () => {
    throw err;
  });
  a.use(errorHandler);
  return a;
}

describe('errorHandler', () => {
  const originalEnv = env.NODE_ENV;
  afterEach(() => {
    env.NODE_ENV = originalEnv;
  });

  test('production: unexpected server errors are masked', async () => {
    env.NODE_ENV = 'production';
    const res = await request(appThrowing(new Error('The column `orders.pickup_station_id` does not exist'))).get('/x');
    expect(res.statusCode).toBe(500);
    expect(res.body.message).toBe('Something went wrong on our side. Please try again shortly.');
    expect(JSON.stringify(res.body)).not.toMatch(/pickup_station_id|stack/);
  });

  test('production: deliberate errors keep their message and status', async () => {
    env.NODE_ENV = 'production';
    const res = await request(appThrowing(new AppError('Product not found', 404))).get('/x');
    expect(res.statusCode).toBe(404);
    expect(res.body.message).toBe('Product not found');
  });

  test('production: a deliberate 503 is still shown (it is safe, operational text)', async () => {
    env.NODE_ENV = 'production';
    const res = await request(appThrowing(new AppError('Database connection check failed', 503))).get('/x');
    expect(res.body.message).toBe('Database connection check failed');
  });

  test('outside production the real message is visible for debugging', async () => {
    env.NODE_ENV = 'test';
    const res = await request(appThrowing(new Error('boom detail'))).get('/x');
    expect(res.body.message).toBe('boom detail');
  });
});
