const express = require('express');
const { z } = require('zod');
const { authenticateAdmin, requireRole } = require('../middleware/adminAuth');
const validateRequest = require('../middleware/requestValidator');
const { logAudit } = require('../services/audit.service');
const store = require('../services/store.service');

/**
 * Storefront content managed from the console.
 *  /api/admin/content/store   GET (all staff) | PUT (ADMIN, SUPER_ADMIN)
 *  /api/admin/content/faqs    GET (all staff) | POST/PUT/DELETE (ADMIN, SUPER_ADMIN)
 */
const router = express.Router();
router.use(authenticateAdmin);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const editors = requireRole('ADMIN', 'SUPER_ADMIN');
const anyStaff = requireRole('DISPATCHER', 'ADMIN', 'SUPER_ADMIN');

const optionalText = (max) => z.string().trim().max(max).nullable().optional();

router.get('/store', anyStaff, wrap(async (req, res) => {
  res.json({ success: true, data: { store: await store.getAdminStore() } });
}));

router.put(
  '/store',
  editors,
  validateRequest({
    body: z.object({
      storeName: z.string().trim().min(2).max(100).optional(),
      supportPhone: optionalText(30),
      whatsappPhone: optionalText(30),
      supportEmail: z
        .union([z.string().trim().email('Support email must be a valid email address').max(255), z.literal(''), z.null()])
        .optional(),
      addressText: optionalText(300),
      businessHours: optionalText(150),
      announcement: optionalText(200),
    }),
  }),
  wrap(async (req, res) => {
    const saved = await store.updateStore(req.body);
    await logAudit({ adminId: req.admin.id, action: 'STORE_PROFILE_UPDATE', entityName: 'StoreProfile', entityId: '1', details: req.body, ipAddress: req.ip });
    res.json({ success: true, message: 'Store details saved', data: { store: saved } });
  })
);

const faqBody = z.object({
  question: z.string().trim().min(5, 'Question must be at least 5 characters').max(200),
  answer: z.string().trim().min(5, 'Answer must be at least 5 characters').max(3000),
  displayOrder: z.coerce.number().int().min(0).max(100000).optional(),
  isActive: z.boolean().optional(),
});
const faqId = z.object({ id: z.coerce.number().int().positive() });

router.get('/faqs', anyStaff, wrap(async (req, res) => {
  res.json({ success: true, data: { faqs: await store.listAdminFaqs() } });
}));

router.post('/faqs', editors, validateRequest({ body: faqBody }), wrap(async (req, res) => {
  const faq = await store.createFaq(req.body);
  await logAudit({ adminId: req.admin.id, action: 'FAQ_CREATE', entityName: 'Faq', entityId: String(faq.id), details: req.body, ipAddress: req.ip });
  res.status(201).json({ success: true, message: 'FAQ added', data: { faq } });
}));

router.put('/faqs/:id', editors, validateRequest({ params: faqId, body: faqBody.partial() }), wrap(async (req, res) => {
  const faq = await store.updateFaq(req.params.id, req.body);
  await logAudit({ adminId: req.admin.id, action: 'FAQ_UPDATE', entityName: 'Faq', entityId: String(faq.id), details: req.body, ipAddress: req.ip });
  res.json({ success: true, message: 'FAQ saved', data: { faq } });
}));

router.delete('/faqs/:id', editors, validateRequest({ params: faqId }), wrap(async (req, res) => {
  await store.deleteFaq(req.params.id);
  await logAudit({ adminId: req.admin.id, action: 'FAQ_DELETE', entityName: 'Faq', entityId: String(req.params.id), ipAddress: req.ip });
  res.json({ success: true, message: 'FAQ deleted' });
}));

module.exports = router;
