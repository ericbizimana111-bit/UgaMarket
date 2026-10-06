/**
 * Admin-controlled storefront content and staff accounts.
 *
 * Covers:
 *   GET  /api/store                       — public contact details + FAQs (localized)
 *   GET/PUT /api/admin/content/store      — store profile (ADMIN+ write, DISPATCHER read)
 *   CRUD /api/admin/content/faqs          — FAQs
 *   /api/admin/staff                      — staff management by the ONE super admin (owner)
 */

const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const prisma = require('../src/config/db');
const { signAdminToken } = require('../src/services/token.service');

const TEST_DOMAIN = '@staff-test.ugamarket.ug';

async function makeAdmin(role, label) {
  const admin = await prisma.admin.create({
    data: {
      fullName: `Test ${label}`,
      email: `${label.toLowerCase()}.${Date.now()}${TEST_DOMAIN}`,
      passwordHash: await bcrypt.hash('Original123456', 4),
      role,
      isActive: true,
    },
  });
  return { admin, token: signAdminToken(admin) };
}

describe('Store content & staff management', () => {
  let superAdmin;
  let admin;
  let dispatcher;
  let originalStore;
  const createdFaqIds = [];

  beforeAll(async () => {
    // There is exactly one super admin (the owner); use it, or create it on an
    // empty database.
    const owner = await prisma.admin.findFirst({ where: { role: 'SUPER_ADMIN' } });
    superAdmin = owner ? { admin: owner, token: signAdminToken(owner) } : await makeAdmin('SUPER_ADMIN', 'Owner');
    admin = await makeAdmin('ADMIN', 'Admin');
    dispatcher = await makeAdmin('DISPATCHER', 'Dispatcher');
    originalStore = await prisma.storeProfile.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  });

  afterAll(async () => {
    const { id, updatedAt, ...restore } = originalStore;
    await prisma.storeProfile.update({ where: { id: 1 }, data: restore });
    if (createdFaqIds.length) await prisma.faq.deleteMany({ where: { id: { in: createdFaqIds } } });
    const testAdmins = await prisma.admin.findMany({ where: { email: { endsWith: TEST_DOMAIN } }, select: { id: true } });
    const ids = testAdmins.map((a) => a.id);
    await prisma.auditLog.deleteMany({ where: { adminId: { in: ids } } });
    await prisma.admin.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  describe('store profile', () => {
    test('public endpoint needs no login and never exposes internal fields', async () => {
      const res = await request(app).get('/api/store');
      expect(res.statusCode).toBe(200);
      expect(res.body.data.store).toHaveProperty('storeName');
      expect(res.body.data.store).not.toHaveProperty('announcementTranslations');
      expect(Array.isArray(res.body.data.faqs)).toBe(true);
    });

    test('ADMIN saves contact details; phones are normalized to +256', async () => {
      const res = await request(app)
        .put('/api/admin/content/store')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({
          supportPhone: '0772 123 456',
          whatsappPhone: '0701234567',
          supportEmail: 'Help@UgaMarket.UG',
          businessHours: 'Mon–Sat, 8am–8pm',
          announcement: 'Free delivery in Kampala this week',
        });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.store).toMatchObject({
        supportPhone: '+256772123456',
        whatsappPhone: '+256701234567',
        supportEmail: 'help@ugamarket.ug',
        announcement: 'Free delivery in Kampala this week',
      });

      const pub = await request(app).get('/api/store');
      expect(pub.body.data.store.supportPhone).toBe('+256772123456');
    });

    test('clearing a field with an empty string stores null', async () => {
      const res = await request(app)
        .put('/api/admin/content/store')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ whatsappPhone: '', supportEmail: '' });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.store.whatsappPhone).toBeNull();
      expect(res.body.data.store.supportEmail).toBeNull();
    });

    test('invalid phone and email are rejected', async () => {
      const badPhone = await request(app)
        .put('/api/admin/content/store')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ supportPhone: '12345' });
      expect(badPhone.statusCode).toBe(422);

      const badEmail = await request(app)
        .put('/api/admin/content/store')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ supportEmail: 'not-an-email' });
      expect(badEmail.statusCode).toBe(400);
    });

    test('DISPATCHER can read but not edit; anonymous is refused', async () => {
      const read = await request(app).get('/api/admin/content/store').set('Authorization', `Bearer ${dispatcher.token}`);
      expect(read.statusCode).toBe(200);
      const write = await request(app)
        .put('/api/admin/content/store')
        .set('Authorization', `Bearer ${dispatcher.token}`)
        .send({ businessHours: 'Never' });
      expect(write.statusCode).toBe(403);
      const anon = await request(app).put('/api/admin/content/store').send({ businessHours: 'Never' });
      expect(anon.statusCode).toBe(401);
    });
  });

  describe('FAQs', () => {
    let faqId;

    test('ADMIN creates an FAQ that appears on the storefront', async () => {
      const res = await request(app)
        .post('/api/admin/content/faqs')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ question: 'Do you deliver to Gulu?', answer: 'Yes, we deliver to every district in Uganda.' });
      expect(res.statusCode).toBe(201);
      faqId = res.body.data.faq.id;
      createdFaqIds.push(faqId);

      const pub = await request(app).get('/api/store');
      expect(pub.body.data.faqs.map((f) => f.question)).toContain('Do you deliver to Gulu?');
    });

    test('other languages fall back to English until translated', async () => {
      const pub = await request(app).get('/api/store?lang=lg');
      const faq = pub.body.data.faqs.find((f) => f.id === faqId);
      expect(faq.question).toBe('Do you deliver to Gulu?');
    });

    test('hiding an FAQ removes it from the storefront but not the console', async () => {
      const res = await request(app)
        .put(`/api/admin/content/faqs/${faqId}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ isActive: false });
      expect(res.statusCode).toBe(200);

      const pub = await request(app).get('/api/store');
      expect(pub.body.data.faqs.some((f) => f.id === faqId)).toBe(false);
      const list = await request(app).get('/api/admin/content/faqs').set('Authorization', `Bearer ${dispatcher.token}`);
      expect(list.body.data.faqs.some((f) => f.id === faqId)).toBe(true);
    });

    test('changing the English text clears stale translations', async () => {
      await prisma.faq.update({ where: { id: faqId }, data: { translations: { LG: { name: 'old', description: 'old' } } } });
      const res = await request(app)
        .put(`/api/admin/content/faqs/${faqId}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ answer: 'Yes, to all 146 districts.' });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.faq.translatedLanguages).toEqual([]);
    });

    test('validation, RBAC and delete', async () => {
      const short = await request(app)
        .post('/api/admin/content/faqs')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ question: 'Hi', answer: 'x' });
      expect(short.statusCode).toBe(400);

      const asDispatcher = await request(app)
        .delete(`/api/admin/content/faqs/${faqId}`)
        .set('Authorization', `Bearer ${dispatcher.token}`);
      expect(asDispatcher.statusCode).toBe(403);

      const del = await request(app).delete(`/api/admin/content/faqs/${faqId}`).set('Authorization', `Bearer ${admin.token}`);
      expect(del.statusCode).toBe(200);
      const again = await request(app).delete(`/api/admin/content/faqs/${faqId}`).set('Authorization', `Bearer ${admin.token}`);
      expect(again.statusCode).toBe(404);
    });
  });

  describe('staff accounts', () => {
    let newStaffId;
    const email = `new.dispatcher${TEST_DOMAIN}`;

    test('only the owner (super admin) can manage staff', async () => {
      const asAdmin = await request(app).get('/api/admin/staff').set('Authorization', `Bearer ${admin.token}`);
      expect(asAdmin.statusCode).toBe(403);
      const asSuper = await request(app).get('/api/admin/staff').set('Authorization', `Bearer ${superAdmin.token}`);
      expect(asSuper.statusCode).toBe(200);
      for (const s of asSuper.body.data.staff) expect(s).not.toHaveProperty('passwordHash');
    });

    test('create a dispatcher who can then log in', async () => {
      const weak = await request(app)
        .post('/api/admin/staff')
        .set('Authorization', `Bearer ${superAdmin.token}`)
        .send({ fullName: 'Weak', email, password: 'short', role: 'DISPATCHER' });
      expect(weak.statusCode).toBe(400);

      const res = await request(app)
        .post('/api/admin/staff')
        .set('Authorization', `Bearer ${superAdmin.token}`)
        .send({ fullName: 'Okello Rider', email: email.toUpperCase(), password: 'Dispatch2026x', role: 'DISPATCHER' });
      expect(res.statusCode).toBe(201);
      expect(res.body.data.staff.email).toBe(email);
      expect(res.body.data.staff).not.toHaveProperty('passwordHash');
      newStaffId = res.body.data.staff.id;

      const dup = await request(app)
        .post('/api/admin/staff')
        .set('Authorization', `Bearer ${superAdmin.token}`)
        .send({ fullName: 'Dup', email, password: 'Dispatch2026x', role: 'ADMIN' });
      expect(dup.statusCode).toBe(409);

      const login = await request(app).post('/api/admin/auth/login').send({ email, password: 'Dispatch2026x' });
      expect(login.statusCode).toBe(200);
      expect(login.body.data.admin.role).toBe('DISPATCHER');
    });

    test('promote, reset password, and deactivation locks the account out immediately', async () => {
      const promote = await request(app)
        .patch(`/api/admin/staff/${newStaffId}`)
        .set('Authorization', `Bearer ${superAdmin.token}`)
        .send({ role: 'ADMIN' });
      expect(promote.statusCode).toBe(200);
      expect(promote.body.data.staff.role).toBe('ADMIN');

      const reset = await request(app)
        .post(`/api/admin/staff/${newStaffId}/reset-password`)
        .set('Authorization', `Bearer ${superAdmin.token}`)
        .send({ password: 'NewSecret2026y' });
      expect(reset.statusCode).toBe(200);
      const oldLogin = await request(app).post('/api/admin/auth/login').send({ email, password: 'Dispatch2026x' });
      expect(oldLogin.statusCode).toBe(401);
      const login = await request(app).post('/api/admin/auth/login').send({ email, password: 'NewSecret2026y' });
      expect(login.statusCode).toBe(200);
      const staffToken = login.body.data.token;

      const off = await request(app)
        .patch(`/api/admin/staff/${newStaffId}`)
        .set('Authorization', `Bearer ${superAdmin.token}`)
        .send({ isActive: false });
      expect(off.statusCode).toBe(200);

      // An already-issued token stops working on the next request.
      const blocked = await request(app).get('/api/admin/content/store').set('Authorization', `Bearer ${staffToken}`);
      expect(blocked.statusCode).toBe(401);
    });

    test('the owner cannot be demoted or deactivated', async () => {
      const demote = await request(app)
        .patch(`/api/admin/staff/${superAdmin.admin.id}`)
        .set('Authorization', `Bearer ${superAdmin.token}`)
        .send({ role: 'ADMIN' });
      expect(demote.statusCode).toBe(409);
      const off = await request(app)
        .patch(`/api/admin/staff/${superAdmin.admin.id}`)
        .set('Authorization', `Bearer ${superAdmin.token}`)
        .send({ isActive: false });
      expect(off.statusCode).toBe(409);
    });

    test('nobody can be created as, or promoted to, super admin', async () => {
      const create = await request(app)
        .post('/api/admin/staff')
        .set('Authorization', `Bearer ${superAdmin.token}`)
        .send({ fullName: 'Second Owner', email: `second.owner${TEST_DOMAIN}`, password: 'Owner2026xyz', role: 'SUPER_ADMIN' });
      expect(create.statusCode).toBe(400);
      expect(create.body.errors[0].message).toMatch(/only one super admin/i);

      const promote = await request(app)
        .patch(`/api/admin/staff/${admin.admin.id}`)
        .set('Authorization', `Bearer ${superAdmin.token}`)
        .send({ role: 'SUPER_ADMIN' });
      expect(promote.statusCode).toBe(400);

      // The service refuses it too (defence in depth behind the route validator).
      const staffService = require('../src/services/staff.service');
      await expect(staffService.updateStaff(superAdmin.admin, admin.admin.id, { role: 'SUPER_ADMIN' })).rejects.toMatchObject({ statusCode: 422 });
      expect(staffService.ASSIGNABLE_ROLES).toEqual(['ADMIN', 'DISPATCHER']);
    });

    test('the database itself refuses a second super admin', async () => {
      await expect(
        prisma.admin.create({
          data: { fullName: 'Sneaky', email: `sneaky${TEST_DOMAIN}`, passwordHash: 'x', role: 'SUPER_ADMIN' },
        })
      ).rejects.toMatchObject({ code: 'P2002' });
      expect(await prisma.admin.count({ where: { role: 'SUPER_ADMIN' } })).toBe(1);
    });

    test('the owner assigns roles: dispatcher <-> admin', async () => {
      const toAdmin = await request(app)
        .patch(`/api/admin/staff/${dispatcher.admin.id}`)
        .set('Authorization', `Bearer ${superAdmin.token}`)
        .send({ role: 'ADMIN' });
      expect(toAdmin.body.data.staff.role).toBe('ADMIN');
      const back = await request(app)
        .patch(`/api/admin/staff/${dispatcher.admin.id}`)
        .set('Authorization', `Bearer ${superAdmin.token}`)
        .send({ role: 'DISPATCHER' });
      expect(back.body.data.staff.role).toBe('DISPATCHER');
    });
  });
});
