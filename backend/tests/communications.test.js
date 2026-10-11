/**
 * Message receipts (sent / delivered / read), customer -> staff voice calls,
 * checkout consent records and the newsletter (double opt-in, unsubscribe,
 * new-arrivals digest).
 */
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/db');
const env = require('../src/config/env');
const realtime = require('../src/services/realtime.service');
const newsletter = require('../src/services/newsletter.service');
const { LEGAL_VERSIONS } = require('../src/services/consent.service');
const { createTestAddress, CHECKOUT_CONSENT } = require('./helpers/fixtures');

jest.setTimeout(60000);

describe('Communications & consent', () => {
  let adminToken;
  let adminId;
  const users = [];
  const emails = [];
  const productIds = [];
  const orderIds = [];
  const startedAt = new Date();

  async function makeCustomer(name) {
    for (let i = 0; i < 5; i++) {
      const phone = `+2567${Math.floor(10000000 + Math.random() * 89999999)}`;
      const reg = await request(app).post('/api/auth/register').send({ fullName: `${name} ${i}`, phone, password: 'CommsPass123!' });
      if (reg.statusCode === 409) continue;
      users.push(reg.body.data.user.id);
      return { id: reg.body.data.user.id, token: reg.body.data.token, phone };
    }
    throw new Error('could not create customer');
  }

  /** Pretend staff consoles / customer tabs are connected. */
  function online(channels) {
    return jest.spyOn(realtime, 'subscriberCount').mockImplementation((c) => (channels.includes(c) ? 1 : 0));
  }

  beforeAll(async () => {
    const login = await request(app).post('/api/admin/auth/login').send({ email: env.ADMIN_1_EMAIL, password: env.ADMIN_1_PASSWORD });
    adminToken = login.body.data.token;
    adminId = (await prisma.admin.findUnique({ where: { email: env.ADMIN_1_EMAIL } })).id;
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await prisma.consentRecord.deleteMany({ where: { userId: { in: users } } });
    await prisma.callSession.deleteMany({ where: { userId: { in: users } } });
    await prisma.adminNotification.deleteMany({ where: { type: { in: ['MISSED_CALL', 'NEW_MESSAGE', 'NEW_ORDER'] }, createdAt: { gte: startedAt } } });
    await prisma.newsletterSubscriber.deleteMany({ where: { email: { in: emails } } });
    for (const id of orderIds) {
      await prisma.delivery.deleteMany({ where: { orderId: id } });
      await prisma.payment.deleteMany({ where: { orderId: id } });
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: id } });
      await prisma.orderItem.deleteMany({ where: { orderId: id } });
      await prisma.order.deleteMany({ where: { id } });
    }
    await prisma.inventoryTransaction.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.conversation.deleteMany({ where: { userId: { in: users } } });
    await prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await prisma.address.deleteMany({ where: { userId: { in: users } } });
    await prisma.cart.deleteMany({ where: { userId: { in: users } } });
    await prisma.securityEvent.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  });

  // ------------------------------------------------------------
  describe('message receipts', () => {
    test('sent -> delivered -> read, both directions', async () => {
      const c = await makeCustomer('Receipt Customer');

      // Staff offline: the customer's message is only "sent".
      online([]);
      const sent = await request(app).post('/api/chat/messages').set('Authorization', `Bearer ${c.token}`).send({ body: 'Hello there' });
      expect(sent.statusCode).toBe(201);
      expect(sent.body.data.message.deliveredAt).toBeNull();
      expect(sent.body.data.message.readAt).toBeNull();
      const conversationId = sent.body.data.message.conversationId;

      // Staff open the inbox thread -> read (and therefore delivered).
      const publish = jest.spyOn(realtime, 'publish');
      await request(app).post(`/api/admin/chat/conversations/${conversationId}/read`).set('Authorization', `Bearer ${adminToken}`).expect(200);
      const stored = await prisma.chatMessage.findUnique({ where: { id: sent.body.data.message.id } });
      expect(stored.deliveredAt).not.toBeNull();
      expect(stored.readAt).not.toBeNull();
      expect(publish).toHaveBeenCalledWith(`user:${c.id}`, 'chat:read', expect.objectContaining({ by: 'ADMIN', conversationId }));
      jest.restoreAllMocks();

      // Customer online when staff reply: delivered immediately, unread.
      online([`user:${c.id}`]);
      const reply = await request(app)
        .post(`/api/admin/chat/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ body: 'Hi! How can we help?' });
      expect(reply.statusCode).toBe(201);
      expect(reply.body.data.message.deliveredAt).not.toBeNull();
      expect(reply.body.data.message.readAt).toBeNull();

      // Customer opens Messages -> read.
      await request(app).post('/api/chat/read').set('Authorization', `Bearer ${c.token}`).expect(200);
      const thread = await request(app).get('/api/chat').set('Authorization', `Bearer ${c.token}`);
      const staffMsg = thread.body.data.messages.find((m) => m.senderType === 'ADMIN');
      expect(staffMsg.readAt).not.toBeNull();
    });

    test('messages waiting for an offline customer become delivered when they come online', async () => {
      const c = await makeCustomer('Offline Customer');
      online([]);
      const open = await request(app).post('/api/admin/chat/conversations').set('Authorization', `Bearer ${adminToken}`).send({ userId: c.id });
      const reply = await request(app)
        .post(`/api/admin/chat/conversations/${open.body.data.conversation.id}/messages`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ body: 'Your order is ready' });
      expect(reply.body.data.message.deliveredAt).toBeNull();

      const chat = require('../src/services/chat.service');
      await chat.markDeliveredToCustomer(c.id);
      const stored = await prisma.chatMessage.findUnique({ where: { id: reply.body.data.message.id } });
      expect(stored.deliveredAt).not.toBeNull();
      expect(stored.readAt).toBeNull();
    });
  });

  // ------------------------------------------------------------
  describe('voice calls', () => {
    test('requires sign-in', async () => {
      await request(app).post('/api/calls').expect(401);
      await request(app).post('/api/admin/calls/00000000-0000-0000-0000-000000000000/accept').expect(401);
    });

    test('no staff online -> logged as a missed call', async () => {
      const c = await makeCustomer('Missed Caller');
      online([]);
      const res = await request(app).post('/api/calls').set('Authorization', `Bearer ${c.token}`);
      expect(res.statusCode).toBe(503);
      expect(res.body.errors[0].code).toBe('NO_AGENT_ONLINE');
      const call = await prisma.callSession.findFirst({ where: { userId: c.id } });
      expect(call.status).toBe('MISSED');
    });

    test('ring -> accept -> signal relay -> hang up', async () => {
      const c = await makeCustomer('Caller');
      const other = await makeCustomer('Intruder');
      online(['admins']);
      const publish = jest.spyOn(realtime, 'publish');

      const start = await request(app).post('/api/calls').set('Authorization', `Bearer ${c.token}`);
      expect(start.statusCode).toBe(201);
      const callId = start.body.data.call.id;
      expect(start.body.data.config.iceServers.length).toBeGreaterThan(0);
      expect(publish).toHaveBeenCalledWith('admins', 'call:incoming', expect.objectContaining({ callId }));

      // Only one live call per customer.
      await request(app).post('/api/calls').set('Authorization', `Bearer ${c.token}`).expect(409);
      // Signals before the call is answered are refused.
      await request(app).post(`/api/calls/${callId}/signal`).set('Authorization', `Bearer ${c.token}`).send({ type: 'offer', data: { sdp: 'x' } }).expect(409);

      const accept = await request(app).post(`/api/admin/calls/${callId}/accept`).set('Authorization', `Bearer ${adminToken}`);
      expect(accept.statusCode).toBe(200);
      expect(accept.body.data.call.status).toBe('ACTIVE');
      expect(publish).toHaveBeenCalledWith(`user:${c.id}`, 'call:accepted', expect.objectContaining({ callId }));
      // A second answer loses the race.
      await request(app).post(`/api/admin/calls/${callId}/accept`).set('Authorization', `Bearer ${adminToken}`).expect(409);

      // Offer relayed customer -> the answering staff member only.
      await request(app)
        .post(`/api/calls/${callId}/signal`)
        .set('Authorization', `Bearer ${c.token}`)
        .send({ type: 'offer', data: { type: 'offer', sdp: 'v=0' } })
        .expect(200);
      expect(publish).toHaveBeenCalledWith(`admin:${adminId}`, 'call:signal', expect.objectContaining({ callId, type: 'offer' }));
      // Staff answer relayed back to the customer.
      await request(app)
        .post(`/api/admin/calls/${callId}/signal`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ type: 'answer', data: { type: 'answer', sdp: 'v=0' } })
        .expect(200);
      expect(publish).toHaveBeenCalledWith(`user:${c.id}`, 'call:signal', expect.objectContaining({ type: 'answer' }));

      // Wrong side / foreign customer / oversized payload are refused.
      await request(app).post(`/api/calls/${callId}/signal`).set('Authorization', `Bearer ${c.token}`).send({ type: 'answer', data: {} }).expect(400);
      await request(app).post(`/api/calls/${callId}/signal`).set('Authorization', `Bearer ${other.token}`).send({ type: 'ice', data: {} }).expect(404);
      await request(app)
        .post(`/api/calls/${callId}/signal`)
        .set('Authorization', `Bearer ${c.token}`)
        .send({ type: 'ice', data: { candidate: 'x'.repeat(20000) } })
        .expect(413);

      const end = await request(app).post(`/api/calls/${callId}/end`).set('Authorization', `Bearer ${c.token}`).send({});
      expect(end.statusCode).toBe(200);
      expect(end.body.data.call.status).toBe('ENDED');
      expect(publish).toHaveBeenCalledWith('admins', 'call:ended', expect.objectContaining({ callId }));

      const log = await request(app).get('/api/admin/calls').set('Authorization', `Bearer ${adminToken}`);
      expect(log.body.data.calls.some((x) => x.id === callId && x.status === 'ENDED')).toBe(true);
    });

    test('staff can call a customer: ring -> customer answers -> staff offer, customer answer', async () => {
      const c = await makeCustomer('Called Customer');
      const other = await makeCustomer('Other Customer');
      online([`user:${c.id}`]);
      const publish = jest.spyOn(realtime, 'publish');

      const start = await request(app).post('/api/admin/calls').set('Authorization', `Bearer ${adminToken}`).send({ userId: c.id });
      expect(start.statusCode).toBe(201);
      const callId = start.body.data.call.id;
      expect(start.body.data.call.direction).toBe('OUTBOUND');
      expect(publish).toHaveBeenCalledWith(`user:${c.id}`, 'call:incoming', expect.objectContaining({ callId }));

      // Staff cannot place a second call at the same time; another customer cannot answer it.
      await request(app).post('/api/admin/calls').set('Authorization', `Bearer ${adminToken}`).send({ userId: other.id }).expect(409);
      await request(app).post(`/api/calls/${callId}/accept`).set('Authorization', `Bearer ${other.token}`).expect(409);

      const accept = await request(app).post(`/api/calls/${callId}/accept`).set('Authorization', `Bearer ${c.token}`);
      expect(accept.statusCode).toBe(200);
      expect(accept.body.data.call.status).toBe('ACTIVE');
      expect(publish).toHaveBeenCalledWith(`admin:${adminId}`, 'call:accepted', expect.objectContaining({ callId }));

      // Staff placed the call, so staff send the offer and the customer answers.
      await request(app).post(`/api/calls/${callId}/signal`).set('Authorization', `Bearer ${c.token}`).send({ type: 'offer', data: {} }).expect(400);
      await request(app)
        .post(`/api/admin/calls/${callId}/signal`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ type: 'offer', data: { type: 'offer', sdp: 'v=0' } })
        .expect(200);
      expect(publish).toHaveBeenCalledWith(`user:${c.id}`, 'call:signal', expect.objectContaining({ type: 'offer' }));
      await request(app)
        .post(`/api/calls/${callId}/signal`)
        .set('Authorization', `Bearer ${c.token}`)
        .send({ type: 'answer', data: { type: 'answer', sdp: 'v=0' } })
        .expect(200);
      expect(publish).toHaveBeenCalledWith(`admin:${adminId}`, 'call:signal', expect.objectContaining({ type: 'answer' }));

      // After a network change the answering side may ask the caller to reconnect; the caller may not.
      await request(app).post(`/api/calls/${callId}/signal`).set('Authorization', `Bearer ${c.token}`).send({ type: 'restart', data: null }).expect(200);
      expect(publish).toHaveBeenCalledWith(`admin:${adminId}`, 'call:signal', expect.objectContaining({ type: 'restart' }));
      await request(app).post(`/api/admin/calls/${callId}/signal`).set('Authorization', `Bearer ${adminToken}`).send({ type: 'restart', data: null }).expect(400);

      const end = await request(app).post(`/api/admin/calls/${callId}/end`).set('Authorization', `Bearer ${adminToken}`).send({});
      expect(end.body.data.call.status).toBe('ENDED');
    });

    test('calling a customer who is offline logs a missed call and tells them', async () => {
      const c = await makeCustomer('Offline Callee');
      online([]);
      const res = await request(app).post('/api/admin/calls').set('Authorization', `Bearer ${adminToken}`).send({ userId: c.id });
      expect(res.statusCode).toBe(409);
      expect(res.body.errors[0].code).toBe('CUSTOMER_OFFLINE');
      const note = await prisma.notification.findFirst({ where: { userId: c.id, type: 'MISSED_CALL' } });
      expect(note).not.toBeNull();
    });

    test('a customer can decline a staff call', async () => {
      const c = await makeCustomer('Declining Customer');
      online([`user:${c.id}`]);
      const start = await request(app).post('/api/admin/calls').set('Authorization', `Bearer ${adminToken}`).send({ userId: c.id }).expect(201);
      const reject = await request(app).post(`/api/calls/${start.body.data.call.id}/reject`).set('Authorization', `Bearer ${c.token}`);
      expect(reject.body.data.call.status).toBe('REJECTED');
    });

    test('a call whose participant disconnected (browser closed) is ended, so nobody stays busy', async () => {
      const callService = require('../src/services/call.service');
      const c = await makeCustomer('Vanishing Caller');
      online(['admins']);
      const start = await request(app).post('/api/calls').set('Authorization', `Bearer ${c.token}`).expect(201);
      await request(app).post(`/api/admin/calls/${start.body.data.call.id}/accept`).set('Authorization', `Bearer ${adminToken}`).expect(200);

      // Staff browser closes and does not come back within the grace period.
      online([]);
      const closed = await callService.handleChannelEmpty(`admin:${adminId}`, 10);
      expect(closed).toBe(1);
      const call = await prisma.callSession.findUnique({ where: { id: start.body.data.call.id } });
      expect(call.status).toBe('ENDED');
      expect(call.endReason).toBe('CONNECTION_LOST');

      // The staff member can place a new call straight away.
      const next = await makeCustomer('Next Callee');
      online([`user:${next.id}`]);
      await request(app).post('/api/admin/calls').set('Authorization', `Bearer ${adminToken}`).send({ userId: next.id }).expect(201);
      online([]);
      await callService.handleChannelEmpty(`user:${next.id}`, 10);
    });

    test('a reconnect within the grace period keeps the call', async () => {
      const callService = require('../src/services/call.service');
      const c = await makeCustomer('Reloading Caller');
      online(['admins', `user:${c.id}`]);
      const start = await request(app).post('/api/calls').set('Authorization', `Bearer ${c.token}`).expect(201);
      expect(await callService.handleChannelEmpty(`user:${c.id}`, 10)).toBe(0);
      expect((await prisma.callSession.findUnique({ where: { id: start.body.data.call.id } })).status).toBe('RINGING');
      await request(app).post(`/api/calls/${start.body.data.call.id}/end`).set('Authorization', `Bearer ${c.token}`).send({});
    });

    test('a customer cancelling while it rings is a missed call', async () => {
      const c = await makeCustomer('Cancel Caller');
      online(['admins']);
      const start = await request(app).post('/api/calls').set('Authorization', `Bearer ${c.token}`).expect(201);
      const end = await request(app).post(`/api/calls/${start.body.data.call.id}/end`).set('Authorization', `Bearer ${c.token}`).send({});
      expect(end.body.data.call.status).toBe('MISSED');
    });
  });

  // ------------------------------------------------------------
  describe('checkout consent', () => {
    let customer;
    let addressId;
    let product;

    beforeAll(async () => {
      customer = await makeCustomer('Consent Buyer');
      addressId = (await createTestAddress(customer.id)).id;
      const category = await prisma.category.findFirst();
      product = await prisma.product.create({
        data: { categoryId: category.id, slug: `consent-item-${Date.now()}`, nameEn: 'Consent Item', priceUgx: 20000, stockQuantity: 50, isActive: true },
      });
      productIds.push(product.id);
    });

    async function addToCart() {
      await request(app).post('/api/cart/items').set('Authorization', `Bearer ${customer.token}`).send({ productId: product.id, quantity: 1 });
    }

    test('an order without accepting the Terms and Privacy Policy is refused', async () => {
      await addToCart();
      const res = await request(app).post('/api/orders').set('Authorization', `Bearer ${customer.token}`).send({ addressId });
      expect(res.statusCode).toBe(400);
      const outdated = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ addressId, acceptTerms: true, termsVersion: '2000-01-01', privacyVersion: LEGAL_VERSIONS.privacy });
      expect(outdated.statusCode).toBe(409);
    });

    test('accepted terms are recorded per order; marketing stays off unless ticked', async () => {
      const res = await request(app).post('/api/orders').set('Authorization', `Bearer ${customer.token}`).send({ ...CHECKOUT_CONSENT, addressId });
      expect(res.statusCode).toBe(201);
      orderIds.push(res.body.data.order.id);
      const records = await prisma.consentRecord.findMany({ where: { orderId: res.body.data.order.id } });
      expect(records.map((r) => r.type).sort()).toEqual(['PRIVACY', 'TERMS']);
      expect(records.every((r) => r.granted && r.source === 'CHECKOUT')).toBe(true);
      expect(records.find((r) => r.type === 'TERMS').version).toBe(LEGAL_VERSIONS.terms);
      const user = await prisma.user.findUnique({ where: { id: customer.id } });
      expect(user.marketingConsent).toBe(false);
    });

    test('ticking marketing consent records it, and it can be withdrawn', async () => {
      await addToCart();
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ ...CHECKOUT_CONSENT, marketingConsent: true, addressId });
      expect(res.statusCode).toBe(201);
      orderIds.push(res.body.data.order.id);
      const marketing = await prisma.consentRecord.findFirst({ where: { orderId: res.body.data.order.id, type: 'MARKETING' } });
      expect(marketing.granted).toBe(true);

      const withdraw = await request(app).put('/api/auth/consents/marketing').set('Authorization', `Bearer ${customer.token}`).send({ granted: false });
      expect(withdraw.statusCode).toBe(200);
      expect(withdraw.body.data.marketingConsent).toBe(false);
      const last = await prisma.consentRecord.findFirst({ where: { userId: customer.id, type: 'MARKETING' }, orderBy: { createdAt: 'desc' } });
      expect(last.granted).toBe(false);
      expect(last.source).toBe('ACCOUNT');
    });
  });

  // ------------------------------------------------------------
  describe('newsletter', () => {
    test('requires explicit consent', async () => {
      const res = await request(app).post('/api/newsletter/subscribe').send({ email: 'no.consent@example.ug' });
      expect(res.statusCode).toBe(400);
    });

    test('double opt-in: pending until confirmed, then unsubscribe', async () => {
      const email = `news.${Date.now()}@example.ug`;
      emails.push(email);
      const sub = await request(app).post('/api/newsletter/subscribe').send({ email, consent: true });
      expect(sub.statusCode).toBe(200);
      const row = await prisma.newsletterSubscriber.findUnique({ where: { email } });
      expect(row.status).toBe('PENDING');
      expect(row.confirmTokenHash).not.toBe(sub.body.data.devToken);

      // Same answer when the address is already on the list.
      const again = await request(app).post('/api/newsletter/subscribe').send({ email, consent: true });
      expect(again.body.message).toBe(sub.body.message);

      await request(app).post('/api/newsletter/confirm').send({ token: sub.body.data.devToken }).expect(200);
      expect((await prisma.newsletterSubscriber.findUnique({ where: { email } })).status).toBe('ACTIVE');
      // Confirmation links are single-use.
      await request(app).post('/api/newsletter/confirm').send({ token: sub.body.data.devToken }).expect(400);

      const active = await prisma.newsletterSubscriber.findUnique({ where: { email } });
      await request(app).post('/api/newsletter/unsubscribe').send({ token: active.unsubscribeToken }).expect(200);
      expect((await prisma.newsletterSubscriber.findUnique({ where: { email } })).status).toBe('UNSUBSCRIBED');
    });

    test('new-arrivals digest announces only products added since the last run', async () => {
      const email = `digest.${Date.now()}@example.ug`;
      emails.push(email);
      await prisma.newsletterSubscriber.create({ data: { email, status: 'ACTIVE', unsubscribeToken: require('crypto').randomBytes(32).toString('hex') } });

      const before = await prisma.newArrivalsDigest.findUnique({ where: { id: 1 } });
      await prisma.newArrivalsDigest.upsert({ where: { id: 1 }, update: { lastAnnouncedAt: new Date() }, create: { id: 1, lastAnnouncedAt: new Date() } });
      await new Promise((r) => setTimeout(r, 20));

      const category = await prisma.category.findFirst();
      const fresh = await prisma.product.create({
        data: { categoryId: category.id, slug: `digest-item-${Date.now()}`, nameEn: 'Digest Item', priceUgx: 15000, stockQuantity: 5, isActive: true },
      });
      productIds.push(fresh.id);

      const first = await newsletter.runNewArrivalsDigest();
      expect(first.products).toBeGreaterThanOrEqual(1);
      expect(first.emails).toBeGreaterThanOrEqual(1);
      const second = await newsletter.runNewArrivalsDigest();
      expect(second.products).toBe(0);

      if (before) await prisma.newArrivalsDigest.update({ where: { id: 1 }, data: { lastAnnouncedAt: before.lastAnnouncedAt } });
    });
  });
});
