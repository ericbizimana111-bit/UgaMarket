const bcrypt = require('bcryptjs');
const prisma = require('../config/db');
const { AppError } = require('../middleware/errorHandler');

/**
 * Staff (admin console) accounts, managed by SUPER_ADMINs.
 *
 * Safety rules:
 *  - a super admin cannot demote or deactivate their own account (no
 *    accidental self-lockout);
 *  - the last active SUPER_ADMIN can never be demoted or deactivated.
 * Deactivation takes effect on the very next request: the admin auth
 * middleware re-checks isActive for every call.
 */

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
  const clash = await prisma.admin.findUnique({ where: { email: normalizedEmail }, select: { id: true } });
  if (clash) throw new AppError('A staff account with this email already exists', 409);
  const passwordHash = await bcrypt.hash(password, 12);
  return prisma.admin.create({
    data: { fullName: fullName.trim(), email: normalizedEmail, passwordHash, role, isActive: true },
    select: SAFE_SELECT,
  });
}

async function updateStaff(actor, id, { fullName, role, isActive }) {
  return prisma.$transaction(async (tx) => {
    const target = await tx.admin.findUnique({ where: { id }, select: SAFE_SELECT });
    if (!target) throw new AppError('Staff account not found', 404);

    const demoting = role !== undefined && target.role === 'SUPER_ADMIN' && role !== 'SUPER_ADMIN';
    const deactivating = isActive === false && target.isActive;

    if (actor.id === id && (demoting || deactivating)) {
      throw new AppError('You cannot demote or deactivate your own account', 409);
    }
    if ((demoting || deactivating) && target.role === 'SUPER_ADMIN' && target.isActive) {
      // Lock every super admin row so two concurrent demotions cannot both pass.
      await tx.$queryRaw`SELECT id FROM admins WHERE role = 'SUPER_ADMIN' FOR UPDATE`;
      const others = await tx.admin.count({ where: { role: 'SUPER_ADMIN', isActive: true, id: { not: id } } });
      if (others === 0) throw new AppError('UgaMarket must keep at least one active super admin', 409);
    }

    return tx.admin.update({
      where: { id },
      data: { fullName: fullName !== undefined ? fullName.trim() : undefined, role, isActive },
      select: SAFE_SELECT,
    });
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
  listStaff,
  createStaff,
  updateStaff,
  resetStaffPassword,
};
