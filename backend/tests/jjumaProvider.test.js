/**
 * JJuma Global provider adapter — unit tests.
 *
 * PURE unit tests: all HTTP is intercepted by stubbing global fetch; no real
 * JJuma credentials exist here. Payload shapes follow the official JJuma
 * documentation (Create Payment, Verify, Webhooks).
 */

const crypto = require('crypto');
const env = require('../src/config/env');
const jjuma = require('../src/services/paymentProviders/jjumaProvider');

// Dummy TEST-shaped credentials (NOT real keys; fetch is always stubbed).
const TEST_KEYS = {
  JJUMA_PUBLIC_KEY: 'bp_test_pub_unit_dummy_public_key',
  JJUMA_SECRET_KEY: 'bp_test_sec_unit_dummy_secret_key',
  JJUMA_WEBHOOK_SECRET: 'jjuma_unit_test_signing_secret_0123456789',
  JJUMA_API_BASE_URL: 'https://api.jjuma.com',
};
const previous = {};
const realFetch = global.fetch;

beforeAll(() => {
  for (const [k, v] of Object.entries(TEST_KEYS)) {
    previous[k] = env[k];
    env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(previous)) env[k] = v;
  global.fetch = realFetch;
});
afterEach(() => {
  global.fetch = realFetch;
});

function stubFetch(status, body) {
  global.fetch = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }));
  return global.fetch;
}

function payment(overrides = {}) {
  return {
    transactionRef: 'PAY-unit-0001',
    amountUgx: 15000,
    currency: 'UGX',
    purpose: 'COMMITMENT',
    method: 'MTN_MOBILE_MONEY',
    orderNumber: 'UM-20261006-0001',
    returnUrl: 'https://shop.example.com/account/orders/abc',
    customer: { fullName: 'Amina N', email: null, phoneE164: '+256772000111' },
    ...overrides,
  };
}

function createResponse(overrides = {}) {
  return {
    success: true,
    status: 'success',
    message: 'Payment created successfully',
    data: {
      transaction_id: 'TXN-A1B2C3D4E5F6',
      reference: 'REF-12345678',
      payment_url: 'https://pay.jjuma.com/pay/TXN-A1B2C3D4E5F6',
      amount: 15000,
      currency: 'UGX',
      status: 'pending',
      ...overrides,
    },
  };
}

function sign(raw, timestamp, secret = TEST_KEYS.JJUMA_WEBHOOK_SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
}

function webhook(event = 'payment.completed', dataOverrides = {}, opts = {}) {
  const body = {
    event,
    event_id: 'evt_123',
    delivery_id: 'wh_456',
    data: {
      transaction_id: 'TXN-A1B2C3D4E5F6',
      reference: 'REF-12345678',
      amount: 15000,
      currency: 'UGX',
      status: 'successful',
      provider: 'jjuma',
      metadata: { transaction_ref: 'PAY-unit-0001' },
      ...dataOverrides,
    },
  };
  const raw = Buffer.from(opts.raw || JSON.stringify(body));
  const timestamp = opts.timestamp || new Date().toISOString();
  const headers = {
    'x-jjuma-signature': opts.signature !== undefined ? opts.signature : sign(raw.toString('utf8'), timestamp),
    'x-jjuma-timestamp': timestamp,
    'x-jjuma-event': event,
  };
  return { rawBody: raw, headers };
}

describe('JJuma provider — initiatePayment', () => {
  test('creates a hosted checkout with the documented fields and the PUBLIC key', async () => {
    const fetch = stubFetch(200, createResponse());
    const result = await jjuma.initiatePayment({ payment: payment() });

    expect(result).toEqual({
      ok: true,
      providerRef: 'TXN-A1B2C3D4E5F6',
      checkoutUrl: 'https://pay.jjuma.com/pay/TXN-A1B2C3D4E5F6',
      outcome: 'PENDING',
      resultCode: 'NONE',
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.jjuma.com/api/v1/payments/create');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${TEST_KEYS.JJUMA_PUBLIC_KEY}`);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      amount: 15000,
      currency: 'UGX',
      customer_name: 'Amina N',
      customer_phone: '+256772000111',
      external_order_id: 'PAY-unit-0001',
      idempotency_key: 'PAY-unit-0001',
      metadata: { transaction_ref: 'PAY-unit-0001', order_number: 'UM-20261006-0001', purpose: 'COMMITMENT' },
      redirect_url: 'https://shop.example.com/account/orders/abc',
      cancel_redirect_url: 'https://shop.example.com/account/orders/abc',
    });
    // Request-level webhook URLs are NOT signed by JJuma: never sent.
    expect(body).not.toHaveProperty('webhook_url');
    // No email on the account → field omitted (JJuma only requires a name).
    expect(body).not.toHaveProperty('customer_email');
  });

  test('Airtel works the same way (network is chosen on the hosted page)', async () => {
    stubFetch(200, createResponse());
    const result = await jjuma.initiatePayment({ payment: payment({ method: 'AIRTEL_MONEY' }) });
    expect(result.ok).toBe(true);
  });

  test('rejects an untrusted checkout URL host', async () => {
    stubFetch(200, createResponse({ payment_url: 'https://evil.example.com/pay/TXN-1' }));
    const result = await jjuma.initiatePayment({ payment: payment() });
    expect(result).toMatchObject({ ok: false, resultCode: 'PROVIDER_ERROR' });
  });

  test('rejects a session created for a different amount', async () => {
    stubFetch(200, createResponse({ amount: 1 }));
    const result = await jjuma.initiatePayment({ payment: payment() });
    expect(result).toMatchObject({ ok: false, failureMessage: 'Payment provider amount mismatch' });
  });

  test('provider error body / HTTP error → normalized failure, no throw', async () => {
    stubFetch(403, { success: false, status: 'error', code: 'VERIFICATION_REQUIRED', message: 'Your account must be verified' });
    const result = await jjuma.initiatePayment({ payment: payment() });
    expect(result).toMatchObject({
      ok: false,
      resultCode: 'PROVIDER_ERROR',
      httpStatus: 403,
      providerCode: 'VERIFICATION_REQUIRED',
      failureMessage: 'The payment provider has not activated this merchant account yet',
    });
  });

  test('a 200 response with success:false keeps the documented error code', async () => {
    stubFetch(200, { success: false, status: 'error', code: 'INVALID_AMOUNT', message: 'Amount too small' });
    const result = await jjuma.initiatePayment({ payment: payment() });
    expect(result).toMatchObject({
      ok: false,
      providerCode: 'INVALID_AMOUNT',
      providerMessage: 'Amount too small',
      failureMessage: 'The payment provider rejected the payment amount',
    });
  });

  test('falls back to checkout_url when payment_url is absent', async () => {
    stubFetch(200, createResponse({ payment_url: undefined, checkout_url: 'https://pay.jjuma.com/pay/TXN-A1B2C3D4E5F6' }));
    const result = await jjuma.initiatePayment({ payment: payment() });
    expect(result).toMatchObject({ ok: true, checkoutUrl: 'https://pay.jjuma.com/pay/TXN-A1B2C3D4E5F6' });
  });

  test('unsupported method fails before any network call', async () => {
    const fetch = stubFetch(200, createResponse());
    const result = await jjuma.initiatePayment({ payment: payment({ method: 'CARD' }) });
    expect(result).toMatchObject({ ok: false, resultCode: 'INVALID_REFERENCE' });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('missing public key → not configured, no network call', async () => {
    const fetch = stubFetch(200, createResponse());
    env.JJUMA_PUBLIC_KEY = '';
    try {
      const result = await jjuma.initiatePayment({ payment: payment() });
      expect(result).toMatchObject({ ok: false, resultCode: 'PROVIDER_ERROR' });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      env.JJUMA_PUBLIC_KEY = TEST_KEYS.JJUMA_PUBLIC_KEY;
    }
  });

  test('network timeout → TIMEOUT result', async () => {
    global.fetch = jest.fn(async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    });
    const result = await jjuma.initiatePayment({ payment: payment() });
    expect(result).toMatchObject({ ok: false, resultCode: 'TIMEOUT' });
  });
});

describe('JJuma provider — verifyPayment', () => {
  test('uses the SECRET key and reports SUCCESS only for the documented paid shape', async () => {
    const fetch = stubFetch(200, {
      success: true,
      status: 'success',
      data: { transaction_id: 'TXN-A1B2C3D4E5F6', amount: 15000, currency: 'UGX', status: 'successful' },
    });
    const result = await jjuma.verifyPayment({ providerRef: 'TXN-A1B2C3D4E5F6' });
    expect(result).toMatchObject({ ok: true, outcome: 'SUCCESS', amountUgx: 15000, currency: 'UGX' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.jjuma.com/api/v1/payments/verify/TXN-A1B2C3D4E5F6');
    expect(init.headers.Authorization).toBe(`Bearer ${TEST_KEYS.JJUMA_SECRET_KEY}`);
  });

  test('a not-yet-successful transaction is PENDING — never an invented failure', async () => {
    stubFetch(200, { success: true, status: 'success', data: { transaction_id: 'TXN-A1B2C3D4E5F6', status: 'pending' } });
    const result = await jjuma.verifyPayment({ providerRef: 'TXN-A1B2C3D4E5F6' });
    expect(result).toMatchObject({ ok: true, outcome: 'PENDING' });
  });

  test.each([
    ['failed', 'DECLINED'],
    ['cancelled', 'CANCELLED_BY_USER'],
    ['expired', 'TIMEOUT'],
  ])('JJuma reporting the transaction %s → FAILED (%s)', async (status, resultCode) => {
    stubFetch(200, { status: 'success', data: { transaction_id: 'TXN-A1B2C3D4E5F6', status, payment_status: status } });
    const result = await jjuma.verifyPayment({ providerRef: 'TXN-A1B2C3D4E5F6' });
    expect(result).toMatchObject({ ok: true, outcome: 'FAILED', resultCode, providerStatus: status });
  });

  test('disagreeing status fields are not trusted as a failure (stays PENDING)', async () => {
    stubFetch(200, { status: 'success', data: { transaction_id: 'TXN-A1B2C3D4E5F6', status: 'failed', payment_status: 'pending' } });
    const result = await jjuma.verifyPayment({ providerRef: 'TXN-A1B2C3D4E5F6' });
    expect(result).toMatchObject({ ok: true, outcome: 'PENDING', resultCode: 'NONE' });
  });

  test('a response for a different transaction is rejected', async () => {
    stubFetch(200, { status: 'success', data: { transaction_id: 'TXN-OTHER', status: 'successful' } });
    const result = await jjuma.verifyPayment({ providerRef: 'TXN-A1B2C3D4E5F6' });
    expect(result).toMatchObject({ ok: false, resultCode: 'INVALID_REFERENCE' });
  });

  test('404 → INVALID_REFERENCE; missing ref → no network call', async () => {
    stubFetch(404, { success: false, code: 'TRANSACTION_NOT_FOUND' });
    expect(await jjuma.verifyPayment({ providerRef: 'TXN-X' })).toMatchObject({ ok: false, resultCode: 'INVALID_REFERENCE' });
    const fetch = stubFetch(200, {});
    expect(await jjuma.verifyPayment({})).toMatchObject({ ok: false, resultCode: 'INVALID_REFERENCE' });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('reference is URL-encoded into the path', async () => {
    const fetch = stubFetch(200, { status: 'success', data: { status: 'pending' } });
    await jjuma.verifyPayment({ providerRef: 'TXN/../x' });
    expect(fetch.mock.calls[0][0]).toBe('https://api.jjuma.com/api/v1/payments/verify/TXN%2F..%2Fx');
  });
});

describe('JJuma provider — verifyWebhook', () => {
  test('valid signature → normalized SUCCESS event', () => {
    const result = jjuma.verifyWebhook(webhook());
    expect(result.ok).toBe(true);
    expect(result.event).toMatchObject({
      providerRef: 'TXN-A1B2C3D4E5F6',
      orderNumber: 'PAY-unit-0001',
      amountUgx: 15000,
      currency: 'UGX',
      outcome: 'SUCCESS',
      resultCode: 'SUCCESS',
    });
  });

  test('raw hex signature without the sha256= prefix is accepted (documented)', () => {
    const w = webhook();
    w.headers['x-jjuma-signature'] = w.headers['x-jjuma-signature'].replace(/^sha256=/, '');
    expect(jjuma.verifyWebhook(w).ok).toBe(true);
  });

  test('numeric epoch timestamps are accepted', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(jjuma.verifyWebhook(webhook('payment.completed', {}, { timestamp: ts })).ok).toBe(true);
  });

  test('wrong secret → INVALID_SIGNATURE', () => {
    const w = webhook();
    w.headers['x-jjuma-signature'] = sign(w.rawBody.toString('utf8'), w.headers['x-jjuma-timestamp'], 'wrong_secret');
    expect(jjuma.verifyWebhook(w)).toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
  });

  test('tampered body (signed then modified) → INVALID_SIGNATURE', () => {
    const w = webhook();
    const tampered = Buffer.from(w.rawBody.toString('utf8').replace('15000', '15'));
    expect(jjuma.verifyWebhook({ rawBody: tampered, headers: w.headers })).toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
  });

  test('missing signature or timestamp → MISSING_SIGNATURE', () => {
    const w = webhook();
    delete w.headers['x-jjuma-timestamp'];
    expect(jjuma.verifyWebhook(w)).toEqual({ ok: false, reason: 'MISSING_SIGNATURE' });
    expect(jjuma.verifyWebhook(webhook('payment.completed', {}, { signature: '' }))).toEqual({
      ok: false,
      reason: 'MISSING_SIGNATURE',
    });
  });

  test('replayed delivery older than 5 minutes → STALE_TIMESTAMP', () => {
    const old = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    expect(jjuma.verifyWebhook(webhook('payment.completed', {}, { timestamp: old }))).toEqual({
      ok: false,
      reason: 'STALE_TIMESTAMP',
    });
  });

  test('no webhook secret configured → every delivery rejected', () => {
    env.JJUMA_WEBHOOK_SECRET = '';
    try {
      expect(jjuma.verifyWebhook(webhook())).toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
    } finally {
      env.JJUMA_WEBHOOK_SECRET = TEST_KEYS.JJUMA_WEBHOOK_SECRET;
    }
  });

  test('success without amount or with non-UGX currency → MALFORMED_PAYLOAD', () => {
    expect(jjuma.verifyWebhook(webhook('payment.completed', { amount: null }))).toEqual({ ok: false, reason: 'MALFORMED_PAYLOAD' });
    expect(jjuma.verifyWebhook(webhook('payment.completed', { currency: 'KES' }))).toEqual({ ok: false, reason: 'MALFORMED_PAYLOAD' });
    expect(jjuma.verifyWebhook(webhook('payment.completed', { amount: 150.5 }))).toEqual({ ok: false, reason: 'MALFORMED_PAYLOAD' });
  });

  test('payment.failed / payment.cancelled → FAILED (amount optional)', () => {
    const failed = jjuma.verifyWebhook(webhook('payment.failed', { amount: undefined, currency: undefined, status: 'failed' }));
    expect(failed.ok).toBe(true);
    expect(failed.event).toMatchObject({ outcome: 'FAILED', resultCode: 'DECLINED', amountUgx: null, currency: null });
    const cancelled = jjuma.verifyWebhook(webhook('payment.cancelled', { status: 'cancelled' }));
    expect(cancelled.event).toMatchObject({ outcome: 'FAILED', resultCode: 'CANCELLED_BY_USER', amountUgx: 15000 });
  });

  test('authentic non-payment events (settlement.*) are acknowledged and ignored', () => {
    expect(jjuma.verifyWebhook(webhook('settlement.completed'))).toEqual({
      ok: true,
      ignore: true,
      eventType: 'settlement.completed',
    });
  });

  test('missing transaction_id or malformed JSON → MALFORMED_PAYLOAD', () => {
    expect(jjuma.verifyWebhook(webhook('payment.completed', { transaction_id: '' }))).toEqual({
      ok: false,
      reason: 'MALFORMED_PAYLOAD',
    });
    expect(jjuma.verifyWebhook(webhook('payment.completed', {}, { raw: '{not json' }))).toEqual({
      ok: false,
      reason: 'MALFORMED_PAYLOAD',
    });
  });

  test('never throws for adversarial inputs', () => {
    const inputs = [undefined, null, {}, { rawBody: 42, headers: {} }, { rawBody: Buffer.from('x'), headers: null }];
    for (const input of inputs) {
      expect(() => jjuma.verifyWebhook(input)).not.toThrow();
      expect(jjuma.verifyWebhook(input).ok).toBe(false);
    }
  });

  test('no secret or key value ever appears in normalized results', async () => {
    stubFetch(500, 'Internal error');
    const results = [
      await jjuma.initiatePayment({ payment: payment() }),
      await jjuma.verifyPayment({ providerRef: 'TXN-1' }),
      jjuma.verifyWebhook(webhook()),
    ];
    const text = JSON.stringify(results);
    for (const secret of Object.values(TEST_KEYS).slice(0, 3)) {
      expect(text).not.toContain(secret);
    }
  });
});
