const { verifyCustomerToken } = require('../services/token.service');
const prisma = require('../config/db');
const { AppError } = require('./errorHandler');

// Same public fields as auth.service SAFE_USER_SELECT (kept here to avoid a
// middleware -> service import cycle).
const SAFE_USER_SELECT = {
  id: true,
  fullName: true,
  phone: true,
  email: true,
  isActive: true,
  emailVerifiedAt: true,
  phoneVerifiedAt: true,
  marketingConsent: true,
  createdAt: true,
  updatedAt: true,
};

/** A token signed before the latest password change is no longer valid. */
function isRevoked(decoded, user) {
  if (!user.passwordChangedAt || !decoded.iat) return false;
  return decoded.iat * 1000 < user.passwordChangedAt.getTime();
}

/**
 * Customer Authentication Middleware
 * Expects: Authorization: Bearer <customer_jwt>
 */
async function authenticateCustomer(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('Authentication token required', 401);
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || !parts[1]) {
      throw new AppError('Malformed authorization header. Expected: Bearer <token>', 401);
    }

    const token = parts[1];
    const decoded = verifyCustomerToken(token);

    const user = await prisma.user.findUnique({
      where: { id: decoded.sub },
      select: { ...SAFE_USER_SELECT, passwordChangedAt: true },
    });

    if (!user || !user.isActive) {
      throw new AppError('User not found or account is inactive', 401);
    }
    if (isRevoked(decoded, user)) {
      throw new AppError('Your password was changed. Please sign in again.', 401);
    }

    const { passwordChangedAt, ...safeUser } = user;
    req.user = safeUser;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  isRevoked,
  authenticateCustomer,
};
