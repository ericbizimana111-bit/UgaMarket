const express = require('express');
const { z } = require('zod');
const { authenticateAdmin, requireRole } = require('../middleware/adminAuth');
const validateRequest = require('../middleware/requestValidator');
const { logAudit } = require('../services/audit.service');
const staff = require('../services/staff.service');

/**
 * Staff accounts (SUPER_ADMIN only).
 *  GET    /api/admin/staff
 *  POST   /api/admin/staff                      { fullName, email, password, role }
 *  PATCH  /api/admin/staff/:id                  { fullName?, role?, isActive? }
 *  POST   /api/admin/staff/:id/reset-password   { password }
 */
const router = express.Router();
router.use(authenticateAdmin, requireRole('SUPER_ADMIN'));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

const roleEnum = z.enum(['SUPER_ADMIN', 'ADMIN', 'DISPATCHER'], {
  errorMap: () => ({ message: 'Role must be SUPER_ADMIN, ADMIN or DISPATCHER' }),
});
const password = z
  .string({ required_error: 'Password is required' })
  .min(10, 'Password must be at least 10 characters')
  .max(100, 'Password cannot exceed 100 characters')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');
const idParams = z.object({
  id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'ID must be a valid UUID'),
});

router.get('/', wrap(async (req, res) => {
  res.json({ success: true, data: { staff: await staff.listStaff() } });
}));

router.post(
  '/',
  validateRequest({
    body: z.object({
      fullName: z.string().trim().min(2, 'Full name is required').max(150),
      email: z.string().trim().email('Enter a valid email address').max(255),
      password,
      role: roleEnum,
    }),
  }),
  wrap(async (req, res) => {
    const created = await staff.createStaff(req.body);
    await logAudit({ adminId: req.admin.id, action: 'STAFF_CREATE', entityName: 'Admin', entityId: created.id, details: { email: created.email, role: created.role }, ipAddress: req.ip });
    res.status(201).json({ success: true, message: 'Staff account created', data: { staff: created } });
  })
);

router.patch(
  '/:id',
  validateRequest({
    params: idParams,
    body: z
      .object({
        fullName: z.string().trim().min(2).max(150).optional(),
        role: roleEnum.optional(),
        isActive: z.boolean().optional(),
      })
      .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nothing to update' }),
  }),
  wrap(async (req, res) => {
    const updated = await staff.updateStaff(req.admin, req.params.id, req.body);
    await logAudit({ adminId: req.admin.id, action: 'STAFF_UPDATE', entityName: 'Admin', entityId: updated.id, details: req.body, ipAddress: req.ip });
    res.json({ success: true, message: 'Staff account updated', data: { staff: updated } });
  })
);

router.post(
  '/:id/reset-password',
  validateRequest({ params: idParams, body: z.object({ password }) }),
  wrap(async (req, res) => {
    await staff.resetStaffPassword(req.params.id, req.body.password);
    // Never log the password itself.
    await logAudit({ adminId: req.admin.id, action: 'STAFF_PASSWORD_RESET', entityName: 'Admin', entityId: req.params.id, ipAddress: req.ip });
    res.json({ success: true, message: 'Password reset' });
  })
);

module.exports = router;
