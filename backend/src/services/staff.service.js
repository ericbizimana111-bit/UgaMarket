const bcrypt = require('bcryptjs');
const prisma = require('../config/db');
const { AppError } = require('../middleware/errorHandler');

/**
 * Staff (admin console) accounts.
 *
 * UgaMarket has exactly ONE super admin: the owner. Only the owner manages
 * staff and assigns the roles that can be given out: ADMIN or DISPATCHER.
 *  - nobody can be created as, or promoted to, SUPER_ADMIN (also enforced by
 *    the database index "admins_single_super_admin");
 *  - the owner account can never be demoted or deactivated (no lock-out).
 * Deactivation takes effect on the very next request: the admin auth
 * middleware re-checks isActive for every call.
 */

/** Roles the owner can assign to other people. */
const ASSIGNABLE_ROLES = ['ADMIN', 'DISPATCHER'];

const SAFE_SELECT = {
  id: true,
  fullName: true,
  email: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
};

async function listStaff() {
  const rows = await prisma.admin.findMany({
    select: { ...SAFE_SELECT, _count: { select: { assignedDeliveries: true } } },
    orderBy: [{ isActive: 'desc' }, { role: 'asc' }, { fullName: 'asc' }],
  });
  return rows.map(({ _count, ...a }) => ({ ...a, assignedDeliveries: _count.assignedDeliveries }));
}

async function createStaff({ fullName, email, password, role }) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!ASSIGNABLE_ROLES.includes(role)) {
    throw new AppError('There is only one super admin (the owner). New staff can be ADMIN or DISPATCHER.', 422);
  }
  const clash = await prisma.admin.findUnique({ where: { email: normalizedEmail }, select: { id: true } });
  if (clash) throw new AppError('A staff account with this email already exists', 409);
  const passwordHash = await bcrypt.hash(password, 12);
  return prisma.admin.create({
    data: { fullName: fullName.trim(), email: normalizedEmail, passwordHash, role, isActive: true },
    select: SAFE_SELECT,
  });
}

async function updateStaff(actor, id, { fullName, role, isActive }) {
  const target = await prisma.admin.findUnique({ where: { id }, select: SAFE_SELECT });
  if (!target) throw new AppError('Staff account not found', 404);

  if (role !== undefined && !ASSIGNABLE_ROLES.includes(role)) {
    throw new AppError('There is only one super admin (the owner). Staff can be ADMIN or DISPATCHER.', 422);
  }
  if (target.role === 'SUPER_ADMIN') {
    // The owner keeps full control: their role and access cannot be removed.
    if (role !== undefined && role !== 'SUPER_ADMIN') {
      throw new AppError('The owner (super admin) role cannot be changed', 409);
    }
    if (isActive === false) {
      throw new AppError('The owner (super admin) account cannot be deactivated', 409);
    }
  }

  return prisma.admin.update({
    where: { id },
    data: { fullName: fullName !== undefined ? fullName.trim() : undefined, role, isActive },
    select: SAFE_SELECT,
  });
}

async function resetStaffPassword(id, password) {
  const target = await prisma.admin.findUnique({ where: { id }, select: { id: true } });
  if (!target) throw new AppError('Staff account not found', 404);
  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.admin.update({ where: { id }, data: { passwordHash } });
  return { id };
}

module.exports = {
  ASSIGNABLE_ROLES,
  listStaff,
  createStaff,
  updateStaff,
  resetStaffPassword,
};
