const crypto = require('crypto');
const request = require('supertest');
const app = require('../src/app');
const env = require('../src/config/env');
const prisma = require('../src/config/db');
const { createTestAddress } = require('./helpers/fixtures');

jest.setTimeout(90000);

/**
 * JJuma Global — end-to-end payment flow through the real app + database.
 *
 * The JJuma API itself is replaced by an in-memory fake behind a global
 * fetch stub that speaks the documented request/response shapes
 * (POST /api/v1/payments/create, GET /api/v1/payments/verify/{id}).
 * Webhooks are signed exactly as documented:
 *   X-Jjuma-Signature = sha256=HMAC_SHA256(secret, timestamp + "." + rawBody)
 */

const TEST_KEYS = {
  PAYMENT_PROVIDER: 'JJUMA',
  JJUMA_PUBLIC_KEY: 'bp_test_pub_e2e_dummy_public_key',
  JJUMA_SECRET_KEY: 'bp_test_sec_e2e_dummy_secret_key',
  JJUMA_WEBHOOK_SECRET: 'jjuma_e2e_test_signing_secret_0123456789',
  JJUMA_API_BASE_URL: 'https://api.jjuma.com',
  FRONTEND_URL: 'https://shop.example.com',
};

// ── Fake JJuma API ──────────────────────────────────────────────────────────
const fakeJjuma = {
  seq: 0,
  transactions: new Map(), // transaction_id → { amount, currency, status, transactionRef }
  requests: [],
  verifyOverride: null, // (txn) => response body, for edge cases
};

function fakeResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

async function fakeFetch(url, init = {}) {
  const u = new URL(String(url));
  fakeJjuma.requests.push({ method: init.method, path: u.pathname, auth: init.headers && init.headers.Authorization });
  if (init.method === 'POST' && u.pathname === '/api/v1/payments/create') {
    const body = JSON.parse(init.body);
    const id = `TXN-E2E${String(++fakeJjuma.seq).padStart(6, '0')}`;
    fakeJjuma.transactions.set(id, {
      amount: body.amount,
      currency: body.currency,
      status: 'pending',
      transactionRef: body.metadata.transaction_ref,
      body,
    });
    return fakeResponse(201, {
      success: true,
      status: 'success',
      message: 'Payment created successfully',
      data: {
        transaction_id: id,
        reference: `REF-${fakeJjuma.seq}`,
        payment_url: `https://pay.jjuma.com/pay/${id}`,
        amount: body.amount,
        currency: body.currency,
        status: 'pending',
      },
    });
  }
  const verify = u.pathname.match(/^\/api\/v1\/payments\/verify\/(.+)$/);
  if (init.method === 'GET' && verify) {
    const id = decodeURIComponent(verify[1]);
    const txn = fakeJjuma.transactions.get(id);
    if (!txn) return fakeResponse(404, { success: false, status: 'error', code: 'TRANSACTION_NOT_FOUND' });
    if (fakeJjuma.verifyOverride) return fakeResponse(200, fakeJjuma.verifyOverride(id, txn));
    return fakeResponse(200, {
      success: true,
      status: 'success',
      data: { transaction_id: id, amount: txn.amount, currency: txn.currency, status: txn.status },
    });
  }
  return fakeResponse(404, { success: false });
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function signedWebhook(event, data, { timestamp = new Date().toISOString(), secret = TEST_KEYS.JJUMA_WEBHOOK_SECRET } = {}) {
  const raw = JSON.stringify({ event, event_id: `evt_${Date.now()}`, delivery_id: `wh_${Date.now()}`, data });
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return request(app)
    .post('/api/payments/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Jjuma-Signature', signature)
    .set('X-Jjuma-Timestamp', timestamp)
    .set('X-Jjuma-Event', event)
    .send(raw);
}

function eventData(payment, overrides = {}) {
  return {
    transaction_id: payment.providerRef,
    reference: 'REF-x',
    amount: payment.amountUgx,
    currency: 'UGX',
    status: 'successful',
    provider: 'jjuma',
    metadata: { transaction_ref: payment.transactionRef },
    ...overrides,
  };
}

describe('JJuma Global payments — end to end', () => {
  const previousEnv = {};
  const realFetch = global.fetch;
  let customerToken = null;
  let addressId = null;
  let product = null;
  const createdUserIds = [];
  const createdProductIds = [];
  const createdOrderIds = [];

  async function makeCustomer() {
    for (let i = 0; i < 5; i++) {
      const phone = `+2567${Math.floor(10000000 + Math.random() * 89999999)}`;
      // Deliberately NO email: JJuma only requires a customer name.
      const reg = await request(app).post('/api/auth/register').send({ fullName: `JJuma Buyer ${Date.now()}`, phone, password: 'JjumaPass123!' });
      if (reg.statusCode === 409) continue;
      expect(reg.statusCode).toBe(201);
      createdUserIds.push(reg.body.data.user.id);
      const login = await request(app).post('/api/auth/login').send({ phone, password: 'JjumaPass123!' });
      const address = await createTestAddress(reg.body.data.user.id);
      return { token: login.body.data.token, addressId: address.id };
    }
    throw new Error('could not create JJuma test customer');
  }

  async function createOrder() {
    await request(app).delete('/api/cart').set('Authorization', `Bearer ${customerToken}`);
    const add = await request(app).post('/api/cart/items').set('Authorization', `Bearer ${customerToken}`).send({ productId: product.id, quantity: 1 });
    expect(add.statusCode).toBe(201);
    const o = await request(app).post('/api/orders').set('Authorization', `Bearer ${customerToken}`).send({ fulfillmentMethod: 'HOME_DELIVERY', addressId });
    expect(o.statusCode).toBe(201);
    createdOrderIds.push(o.body.data.order.id);
    return o.body.data.order;
  }

  async function startPayment(order, method = 'MTN_MOBILE_MONEY') {
    const pay = await request(app).post(`/api/orders/${order.id}/payment`).set('Authorization', `Bearer ${customerToken}`).send({ purpose: 'COMMITMENT', method });
    expect(pay.statusCode).toBe(200);
    return pay.body.data;
  }

  const orderStatus = async (id) => (await prisma.order.findUnique({ where: { id } })).status;
  const paymentRow = async (id) => prisma.payment.findUnique({ where: { id } });

  beforeAll(async () => {
    for (const [k, v] of Object.entries(TEST_KEYS)) {
      previousEnv[k] = env[k];
      env[k] = v;
    }
    global.fetch = fakeFetch;

    const c = await makeCustomer();
    customerToken = c.token;
    addressId = c.addressId;
    const category = await prisma.category.findFirst();
    product = await prisma.product.create({
      data: {
        categoryId: category.id,
        slug: 'jjuma-test-product-' + Date.now(),
        priceUgx: 20000,
        stockQuantity: 60,
        unit: 'piece',
        isActive: true,
        nameEn: 'JJuma Test Product',
        translations: { create: [{ language: 'EN', name: 'JJuma Test Product' }] },
      },
    });
    createdProductIds.push(product.id);
  });

  afterAll(async () => {
    global.fetch = realFetch;
    for (const [k, v] of Object.entries(previousEnv)) env[k] = v;
    for (const oid of createdOrderIds) {
      await prisma.auditLog.deleteMany({ where: { entityId: oid } });
      await prisma.payment.deleteMany({ where: { orderId: oid } });
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: oid } });
      await prisma.inventoryTransaction.deleteMany({ where: { referenceId: oid } });
      await prisma.delivery.deleteMany({ where: { orderId: oid } });
      await prisma.orderItem.deleteMany({ where: { orderId: oid } });
      await prisma.order.deleteMany({ where: { id: oid } });
    }
    for (const pid of createdProductIds) {
      await prisma.cartItem.deleteMany({ where: { productId: pid } });
      await prisma.productTranslation.deleteMany({ where: { productId: pid } });
      await prisma.productImage.deleteMany({ where: { productId: pid } });
      await prisma.inventoryTransaction.deleteMany({ where: { productId: pid } });
      await prisma.product.deleteMany({ where: { id: pid } });
    }
    for (const uid of createdUserIds) {
      await prisma.cartItem.deleteMany({ where: { cart: { userId: uid } } });
      await prisma.cart.deleteMany({ where: { userId: uid } });
      await prisma.user.deleteMany({ where: { id: uid } });
    }
    await prisma.$disconnect();
  });

  afterEach(() => {
    fakeJjuma.verifyOverride = null;
  });

  test('deposit initiation creates a JJuma hosted checkout (no email needed)', async () => {
    const order = await createOrder();
    const data = await startPayment(order, 'AIRTEL_MONEY');

    expect(data.payment.provider).toBe('JJUMA');
    expect(data.payment.status).toBe('PENDING');
    expect(data.payment.providerRef).toMatch(/^TXN-E2E/);
    expect(data.checkoutUrl).toBe(`https://pay.jjuma.com/pay/${data.payment.providerRef}`);

    const sent = fakeJjuma.transactions.get(data.payment.providerRef).body;
    expect(sent.amount).toBe(order.commitmentAmount ?? data.payment.amountUgx);
    expect(sent.amount).toBe(data.payment.amountUgx); // server-authoritative deposit
    expect(sent.currency).toBe('UGX');
    expect(sent.redirect_url).toBe(`https://shop.example.com/account/orders/${order.id}`);
    expect(sent).not.toHaveProperty('webhook_url');
    expect(sent).not.toHaveProperty('customer_email');
    const createCall = fakeJjuma.requests.find((r) => r.method === 'POST');
    expect(createCall.auth).toBe(`Bearer ${TEST_KEYS.JJUMA_PUBLIC_KEY}`);
  });

  test('signed payment.completed → verified with the secret key → order COMMITMENT_PAID; duplicate is a no-op', async () => {
    const order = await createOrder();
    const { payment } = await startPayment(order);
    fakeJjuma.transactions.get(payment.providerRef).status = 'successful';
    fakeJjuma.requests.length = 0;

    const first = await signedWebhook('payment.completed', eventData(payment));
    expect(first.statusCode).toBe(200);
    expect(first.body.event).toBe('PAYMENT_APPLIED');
    expect(fakeJjuma.requests).toContainEqual(
      expect.objectContaining({ method: 'GET', path: `/api/v1/payments/verify/${payment.providerRef}`, auth: `Bearer ${TEST_KEYS.JJUMA_SECRET_KEY}` })
    );
    expect(await orderStatus(order.id)).toBe('COMMITMENT_PAID');
    expect((await paymentRow(payment.id)).status).toBe('SUCCESS');

    const again = await signedWebhook('payment.completed', eventData(payment));
    expect(again.statusCode).toBe(200);
    expect(again.body.event).toBe('ALREADY_PROCESSED');
    const transitions = await prisma.orderStatusHistory.count({ where: { orderId: order.id, statusTo: 'COMMITMENT_PAID' } });
    expect(transitions).toBe(1);
  });

  test('a success JJuma cannot confirm yet is NOT applied (retryable 502), then applies on redelivery', async () => {
    const order = await createOrder();
    const { payment } = await startPayment(order);
    // JJuma's verify API still says pending
    const early = await signedWebhook('payment.completed', eventData(payment));
    expect(early.statusCode).toBe(502);
    expect(await orderStatus(order.id)).toBe('PENDING_PAYMENT');
    expect((await paymentRow(payment.id)).status).toBe('PENDING');

    fakeJjuma.transactions.get(payment.providerRef).status = 'successful';
    const retry = await signedWebhook('payment.completed', eventData(payment));
    expect(retry.statusCode).toBe(200);
    expect(await orderStatus(order.id)).toBe('COMMITMENT_PAID');
  });

  test('forged / tampered / stale webhooks change nothing', async () => {
    const order = await createOrder();
    const { payment } = await startPayment(order);
    fakeJjuma.transactions.get(payment.providerRef).status = 'successful';

    const wrongSecret = await signedWebhook('payment.completed', eventData(payment), { secret: 'attacker-secret' });
    expect(wrongSecret.statusCode).toBe(400);
    const stale = await signedWebhook('payment.completed', eventData(payment), {
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    expect(stale.statusCode).toBe(400);
    const unsigned = await request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').send(JSON.stringify({ event: 'payment.completed', data: eventData(payment) }));
    expect(unsigned.statusCode).toBe(400);

    expect(await orderStatus(order.id)).toBe('PENDING_PAYMENT');
    expect((await paymentRow(payment.id)).status).toBe('PENDING');
  });

  test('a signed event with the wrong amount is rejected even though JJuma says paid', async () => {
    const order = await createOrder();
    const { payment } = await startPayment(order);
    fakeJjuma.transactions.get(payment.providerRef).status = 'successful';

    const res = await signedWebhook('payment.completed', eventData(payment, { amount: payment.amountUgx - 1000 }));
    expect(res.statusCode).toBe(422);
    expect(await orderStatus(order.id)).toBe('PENDING_PAYMENT');
  });

  test('payment.failed (even without amount) records FAILED; order stays unpaid; a later API-confirmed success still applies', async () => {
    const order = await createOrder();
    const { payment } = await startPayment(order);

    const failed = await signedWebhook('payment.failed', eventData(payment, { amount: undefined, currency: undefined, status: 'failed' }));
    expect(failed.statusCode).toBe(200);
    expect(failed.body.event).toBe('PAYMENT_FAILED_RECORDED');
    expect((await paymentRow(payment.id)).status).toBe('FAILED');
    expect(await orderStatus(order.id)).toBe('PENDING_PAYMENT');

    // Customer retried on the same JJuma page and paid: money moved → applied.
    fakeJjuma.transactions.get(payment.providerRef).status = 'successful';
    const success = await signedWebhook('payment.completed', eventData(payment));
    expect(success.statusCode).toBe(200);
    expect(await orderStatus(order.id)).toBe('COMMITMENT_PAID');
  });

  test('a payment completed after our attempt EXPIRED is still credited (never lost)', async () => {
    const order = await createOrder();
    const { payment } = await startPayment(order);
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'EXPIRED' } });
    fakeJjuma.transactions.get(payment.providerRef).status = 'successful';

    const res = await signedWebhook('payment.completed', eventData(payment));
    expect(res.statusCode).toBe(200);
    expect(await orderStatus(order.id)).toBe('COMMITMENT_PAID');
    expect((await paymentRow(payment.id)).status).toBe('SUCCESS');
  });

  test('a second paid checkout for an already-paid order is flagged for staff review, not applied twice', async () => {
    const order = await createOrder();
    const { payment: first } = await startPayment(order);
    await prisma.payment.update({ where: { id: first.id }, data: { status: 'EXPIRED' } });
    const { payment: second } = await startPayment(order);
    expect(second.id).not.toBe(first.id);

    fakeJjuma.transactions.get(second.providerRef).status = 'successful';
    expect((await signedWebhook('payment.completed', eventData(second))).statusCode).toBe(200);
    expect(await orderStatus(order.id)).toBe('COMMITMENT_PAID');

    // The old checkout is paid as well
    fakeJjuma.transactions.get(first.providerRef).status = 'successful';
    const late = await signedWebhook('payment.completed', eventData(first));
    expect(late.statusCode).toBe(200);
    expect(late.body.event).toBe('IGNORED');
    expect((await paymentRow(first.id)).status).toBe('EXPIRED');
    const review = await prisma.adminNotification.findFirst({ where: { orderId: order.id, title: { startsWith: 'Payment needs review' } } });
    expect(review).not.toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { entityId: first.id, action: 'PAYMENT_RECEIVED_NEEDS_REVIEW' } });
    expect(audit).not.toBeNull();
  });

  test('missed webhook: the order page check reconciles through the verify API', async () => {
    const order = await createOrder();
    const { payment } = await startPayment(order);
    fakeJjuma.transactions.get(payment.providerRef).status = 'successful';
    // No webhook arrives (e.g. the backend was asleep).

    const res = await request(app).get(`/api/orders/${order.id}/payment`).set('Authorization', `Bearer ${customerToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.commitmentPaymentStatus).toBe('SUCCESS');
    expect(res.body.data.activePayment).toBeNull();
    expect(await orderStatus(order.id)).toBe('COMMITMENT_PAID');

    // The webhook arriving afterwards is a harmless duplicate
    const late = await signedWebhook('payment.completed', eventData(payment));
    expect(late.body.event).toBe('ALREADY_PROCESSED');
  });

  test('reconciliation never applies a success whose amount JJuma does not confirm', async () => {
    const order = await createOrder();
    const { payment } = await startPayment(order);
    fakeJjuma.verifyOverride = (id) => ({ success: true, status: 'success', data: { transaction_id: id, status: 'successful' } });

    const res = await request(app).get(`/api/orders/${order.id}/payment`).set('Authorization', `Bearer ${customerToken}`);
    expect(res.statusCode).toBe(200);
    expect(await orderStatus(order.id)).toBe('PENDING_PAYMENT');
    expect((await paymentRow(payment.id)).status).toBe('PENDING');
  });

  test('authentic non-payment events (settlement.*) are acknowledged with 200 and ignored', async () => {
    const res = await signedWebhook('settlement.completed', { amount: 1000, currency: 'UGX' });
    expect(res.statusCode).toBe(200);
    expect(res.body.event).toBe('IGNORED');
  });

  test('JJuma being down at checkout fails cleanly with 502 and leaves nothing paid', async () => {
    const order = await createOrder();
    global.fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    try {
      const pay = await request(app).post(`/api/orders/${order.id}/payment`).set('Authorization', `Bearer ${customerToken}`).send({ purpose: 'COMMITMENT' });
      expect(pay.statusCode).toBe(502);
      expect(await orderStatus(order.id)).toBe('PENDING_PAYMENT');
      expect(await prisma.payment.count({ where: { orderId: order.id, status: 'SUCCESS' } })).toBe(0);
    } finally {
      global.fetch = fakeFetch;
    }
  });
});
