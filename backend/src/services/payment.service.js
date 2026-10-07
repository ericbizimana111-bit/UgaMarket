const crypto = require('crypto');
const prisma = require('../config/db');
const env = require('../config/env');
const { AppError } = require('../middleware/errorHandler');
const { getPaymentProvider } = require('./paymentProviders');
const { applyPaymentExpiration } = require('./paymentExpiry.service');
const { applyOrderStatusTransition } = require('./order.service');
const { logAudit } = require('./audit.service');
const { normalizeUgandaPhone } = require('../utils/phone');
const logger = require('../utils/logger');
const notifications = require('./notification.service');
const { formatUGX } = require('../utils/currency');

// Customer-selected payment rails (Phase 12 Step 2). NOT financially
// authoritative — amount/currency/order/purpose stay server-decided. Only
// providers that implement the chosen rail receive it; unsupported rails
// fail initiation with a clear business error rather than faking support.
// UgaMarket accepts mobile money only: MTN MoMo and Airtel Money.
const PROVIDER_METHOD_SUPPORT = {
  MOCK: new Set(['MTN_MOBILE_MONEY', 'AIRTEL_MONEY']),
  // JJuma hosted checkout: the customer confirms the network on pay.jjuma.com
  JJUMA: new Set(['MTN_MOBILE_MONEY', 'AIRTEL_MONEY']),
  FLUTTERWAVE: new Set(['MTN_MOBILE_MONEY', 'AIRTEL_MONEY']),
};

// Minimum gap between server-side reconciliation checks of one attempt
// (the order page polls every few seconds while a payment is in flight).
const RECONCILE_MIN_INTERVAL_MS = 15000;
const lastReconcileAt = new Map();

// Provider initiation result fields that may be surfaced to the frontend.
// Everything else (raw provider payloads, internal notes) stays server-side.
const PROVIDER_INITIATION_FIELDS = ['providerRef', 'checkoutUrl', 'resultCode', 'failureMessage'];

// Initiation calls the provider API while holding the order lock; Prisma's
// default 5 s interactive-transaction timeout is shorter than a provider
// round trip can take (adapters time out at 15 s), so allow for it.
const PROVIDER_CALL_TX_OPTIONS = { maxWait: 10000, timeout: 30000 };

const PAYMENT_ATTEMPT_TTL_MINUTES = env.PAYMENT_ATTEMPT_TTL_MINUTES || 30;
const CURRENCY = 'UGX';

// ============================================================
// Safe payment projection — NEVER exposes raw payloads/secrets
// ============================================================
function formatPayment(payment) {
  return {
    id: payment.id,
    checkoutUrl: (payment.payload && payment.payload.checkoutUrl) || null,
    orderId: payment.orderId,
    purpose: payment.purpose,
    provider: payment.provider,
    paymentType: payment.paymentType,
    transactionRef: payment.transactionRef,
    providerRef: payment.providerRef || null,
    amountUgx: payment.amountUgx,
    currency: payment.currency,
    status: payment.status,
    resultCode: payment.resultCode,
    failureMessage: payment.failureMessage || null,
    expiresAt: payment.expiresAt,
    verifiedAt: payment.verifiedAt,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}

function assertProviderAllowed(provider) {
  if (env.NODE_ENV === 'production' && !provider.isProduction) {
    // Hard guard: production must never run on a fake/sandbox provider
    throw new AppError('Mock payment provider is disabled in production', 403);
  }
}

// ============================================================
// AUTHORITATIVE BALANCE CALCULATION (integer UGX, DB-backed)
// balanceDue = orderTotal - commitmentPaid - balancePaid
// Never trust client amounts or request body values.
// ============================================================
async function calculateOrderBalance(tx, orderId) {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: { payments: true },
  });
  if (!order) {
    throw new AppError('Order not found', 404);
  }

  const successfulPayments = order.payments.filter((p) => p.status === 'SUCCESS');
  const successfulCommitmentPayments = successfulPayments.filter((p) => p.purpose === 'COMMITMENT');
  const successfulBalancePayments = successfulPayments.filter((p) => p.purpose === 'BALANCE');

  const commitmentPaidUgx = successfulCommitmentPayments.reduce((sum, p) => sum + p.amountUgx, 0);
  const balancePaidUgx = successfulBalancePayments.reduce((sum, p) => sum + p.amountUgx, 0);
  const totalPaidUgx = commitmentPaidUgx + balancePaidUgx;

  // Financial invariant checks:
  // - at most 1 successful commitment payment
  // - at most 1 successful balance payment
  // - total paid cannot exceed order total
  if (successfulCommitmentPayments.length > 1) {
    throw new AppError('Corrupted financial state: multiple commitment payments found', 500);
  }
  if (successfulBalancePayments.length > 1) {
    throw new AppError('Corrupted financial state: multiple balance payments found', 500);
  }
  if (totalPaidUgx > order.totalAmount) {
    throw new AppError('Corrupted financial state: total paid exceeds order total amount', 500);
  }

  const balanceDueUgx = Math.max(0, order.totalAmount - totalPaidUgx);

  return {
    orderTotalUgx: order.totalAmount,
    commitmentAmountUgx: order.commitmentAmount,
    remainingBalanceUgx: order.remainingBalance,
    commitmentPaidUgx,
    balancePaidUgx,
    totalPaidUgx,
    balanceDueUgx,
    hasSuccessfulCommitment: successfulCommitmentPayments.length === 1,
    hasSuccessfulBalance: successfulBalancePayments.length === 1,
    isFullyPaid: balanceDueUgx === 0 && (successfulCommitmentPayments.length === 1 || order.totalAmount === 0),
  };
}

// ============================================================
// COMPLETION GUARD (Centralized service-level check)
// Verifies all business and financial prerequisites for completion:
// - commitment payment completed
// - fulfillment completed (delivery DELIVERED)
// - balance fully paid (balanceDue === 0)
// - order not cancelled or refunded
// - order not already completed
// ============================================================
async function canCompleteOrder(tx, orderId) {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: {
      delivery: true,
      payments: true,
    },
  });
  if (!order) {
    return { ok: false, reason: 'Order not found' };
  }

  if (order.status === 'COMPLETED') {
    return { ok: false, reason: 'Order is already completed' };
  }
  if (order.status === 'CANCELLED') {
    return { ok: false, reason: 'Cannot complete a cancelled order' };
  }
  if (order.status === 'REFUNDED') {
    return { ok: false, reason: 'Cannot complete a refunded order' };
  }

  // 1. Commitment payment verification
  const successfulCommitments = order.payments.filter(
    (p) => p.purpose === 'COMMITMENT' && p.status === 'SUCCESS'
  );
  if (order.totalAmount > 0 && successfulCommitments.length !== 1) {
    return { ok: false, reason: 'Commitment payment is not completed' };
  }

  // 2. Fulfillment verification
  const delivery = order.delivery;
  if (!delivery) {
    return { ok: false, reason: 'No fulfillment record found for order' };
  }
  if (delivery.status !== 'DELIVERED') {
    return { ok: false, reason: `Home delivery must be DELIVERED (current: ${delivery.status})` };
  }

  // 3. Balance verification
  const balance = await calculateOrderBalance(tx, orderId);
  if (balance.balanceDueUgx > 0) {
    return { ok: false, reason: `Outstanding balance of UGX ${balance.balanceDueUgx} must be paid` };
  }
  if (balance.totalPaidUgx !== order.totalAmount) {
    return { ok: false, reason: 'Total paid does not match order total' };
  }

  return { ok: true, order, balance };
}

// ============================================================
// COMPLETE ORDER IF ELIGIBLE (Zero-balance order completion)
// Transitions DELIVERED -> BALANCE_PAID -> COMPLETED
// without creating fake financial records.
// ============================================================
async function completeOrderIfEligible(tx, orderId, { changedByType = 'SYSTEM', changedById = null, notes = null } = {}) {
  const guard = await canCompleteOrder(tx, orderId);
  if (!guard.ok) {
    return { completed: false, reason: guard.reason };
  }

  const order = guard.order;
  // If order is currently DELIVERED, transition to BALANCE_PAID
  if (order.status === 'DELIVERED') {
    await applyOrderStatusTransition(tx, {
      orderId: order.id,
      toStatus: 'BALANCE_PAID',
      changedByType,
      changedById,
      notes: notes || 'Balance obligation satisfied (zero balance order)',
    });
  }

  // Transition BALANCE_PAID -> COMPLETED
  const { updatedOrder } = await applyOrderStatusTransition(tx, {
    orderId: order.id,
    toStatus: 'COMPLETED',
    changedByType,
    changedById,
    notes: notes || 'Order completed upon fulfillment verification (zero balance)',
  });

  await logAudit({
    action: 'ORDER_COMPLETED',
    entityName: 'Order',
    entityId: order.id,
    details: {
      orderId: order.id,
      orderNumber: order.orderNumber,
      totalAmount: order.totalAmount,
      zeroBalance: true,
      reason: 'Fulfillment completed and zero balance satisfied',
    },
  });

  return { completed: true, order: updatedOrder };
}

// ============================================================
// COMMITMENT PAYMENT INITIATION (Phase 6 preserved)
// ============================================================
/**
 * The method is a rail HINT, not an authority — but an unsupported rail must
 * fail initiation with a clear business error instead of pretending support.
 */
function assertMethodSupported(provider, method) {
  if (method && !PROVIDER_METHOD_SUPPORT[provider.name]?.has(method)) {
    throw new AppError(`Payment method ${method} is not supported by the ${provider.name} provider`, 422);
  }
}

/**
 * Resolve the customer identity block handed to the provider adapter.
 * Email policy (Phase 12 Step 2 §12): Flutterwave requires an email; the
 * EXISTING user email is used when present, otherwise initiation must fail
 * with a clear business error — fake addresses are never invented, and no
 * identity fields are stored on the Payment row.
 */
function resolveCustomerIdentity(user, method, provider) {
  if (!user || !user.phone) {
    throw new AppError('Customer mobile number is required for payment', 422);
  }
  const phone = normalizeUgandaPhone(user.phone);
  if (!phone.isValid || !phone.normalized) {
    throw new AppError('Customer mobile number is invalid for payment', 422);
  }
  const emailRequired = !provider || provider.requiresCustomerEmail !== false;
  if (emailRequired && (method === 'MTN_MOBILE_MONEY' || method === 'AIRTEL_MONEY')) {
    if (!user.email) {
      throw new AppError(
        'A customer email address is required for mobile money payments. Add an email to your account and try again.',
        422
      );
    }
    return {
      fullName: user.fullName || null,
      email: user.email,
      phoneE164: phone.normalized,
    };
  }
  return { fullName: user.fullName || null, email: user.email || null, phoneE164: phone.normalized };
}

/**
 * Map the DB attempt (+ resolved customer identity) into the provider-agnostic
 * initiation input. The method is a non-authoritative rail hint from the
 * request; amount/currency/references are the server-authoritative DB values.
 */
function buildProviderPaymentInput(attempt, order, { method } = {}, provider = null) {
  return {
    transactionRef: attempt.transactionRef,
    providerRef: attempt.providerRef || null,
    amountUgx: attempt.amountUgx,
    currency: attempt.currency,
    purpose: attempt.purpose,
    method: method || null,
    orderNumber: order.orderNumber,
    // Hosted checkouts send the customer back to their order page, which
    // polls until the server has verified the result.
    returnUrl: `${String(env.FRONTEND_URL || '').replace(/\/+$/, '')}/account/orders/${order.id}`,
    customer: resolveCustomerIdentity(order.user, method, provider),
  };
}

/**
 * Gate initiation results: a provider refusal/network failure must fail the
 * request with a clear business error — never be mistaken for a started
 * attempt. Initiation success does NOT mean the payment succeeded; it only
 * means the provider-side charge attempt was created.
 */
function assertInitiationAccepted(result, attempt) {
  if (!result || result.ok !== true) {
    const detail = (result && result.failureMessage) || 'Payment provider refused the charge request';
    logger.error(`[payment] initiation failed`, {
      provider: env.PAYMENT_PROVIDER,
      transactionRef: attempt.transactionRef,
      resultCode: (result && result.resultCode) || 'PROVIDER_ERROR',
      httpStatus: (result && result.httpStatus) || null,
    });
    throw new AppError(`Payment initiation failed: ${detail}`, 502);
  }
}

/**
 * Whitelisted provider initiation fields surfaced with the initiation
 * response (checkoutUrl etc.). Raw provider payloads never leave the server.
 */
function sanitizeInitiation(result) {
  const safe = {};
  for (const field of PROVIDER_INITIATION_FIELDS) {
    if (result[field] !== undefined && result[field] !== null) {
      safe[field] = result[field];
    }
  }
  return safe;
}

async function initiateCommitmentPayment(userId, orderId, options = {}) {
  const provider = getPaymentProvider(env.PAYMENT_PROVIDER);
  assertProviderAllowed(provider);
  assertMethodSupported(provider, options.method);

  return prisma.$transaction(async (tx) => {
    // 1. Lazy expiry sweep
    await applyPaymentExpiration(tx);

    // 2. Order must exist and belong to this customer (ownership from JWT identity)
    const order = await tx.order.findFirst({
      where: { id: orderId, userId }, // IDOR-safe
      include: { items: true, user: { select: { id: true, fullName: true, email: true, phone: true } } },
    });
    if (!order) {
      throw new AppError('Order not found', 404);
    }
    if (order.currency !== CURRENCY) {
      throw new AppError(`Order currency ${order.currency} is not supported`, 422);
    }

    // 3. Eligibility: exactly the Phase 5 state that may become COMMITMENT_PAID
    if (order.status !== 'PENDING_PAYMENT') {
      // Already paid (COMMITMENT_PAID or beyond): report the existing payment
      const existingSuccess = await tx.payment.findFirst({
        where: { orderId: order.id, purpose: 'COMMITMENT', status: 'SUCCESS' },
        orderBy: { verifiedAt: 'desc' },
      });
      if (existingSuccess) {
        return { payment: existingSuccess, order, reused: true };
      }
      throw new AppError(`Order is not eligible for payment in status ${order.status}`, 409);
    }

    // 4. Idempotent attempt reuse — one active attempt per order+purpose.
    //    Scope locked under the order row to make concurrent initiations safe.
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id}::uuid FOR UPDATE`;

    const reusableStatuses = ['PENDING', 'PROCESSING'];
    let attempt = await tx.payment.findFirst({
      where: { orderId: order.id, purpose: 'COMMITMENT', status: { in: reusableStatuses } },
      orderBy: { createdAt: 'desc' },
    });

    const authoritativeAmount = order.commitmentAmount; // NEVER from the client

    if (!attempt) {
      attempt = await tx.payment.create({
        data: {
          orderId: order.id,
          purpose: 'COMMITMENT',
          paymentType: 'COMMITMENT_ONLINE',
          provider: provider.name,
          transactionRef: `PAY-${crypto.randomUUID()}`,
          amountUgx: authoritativeAmount,
          currency: CURRENCY,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + PAYMENT_ATTEMPT_TTL_MINUTES * 60 * 1000),
        },
      });
    } else if (attempt.amountUgx !== authoritativeAmount) {
      // Stale attempt: expire it and start fresh
      await tx.payment.update({
        where: { id: attempt.id },
        data: { status: 'EXPIRED', resultCode: 'TIMEOUT', failureMessage: 'Superseded by a new attempt' },
      });
      attempt = await tx.payment.create({
        data: {
          orderId: order.id,
          purpose: 'COMMITMENT',
          paymentType: 'COMMITMENT_ONLINE',
          provider: provider.name,
          transactionRef: `PAY-${crypto.randomUUID()}`,
          amountUgx: authoritativeAmount,
          currency: CURRENCY,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + PAYMENT_ATTEMPT_TTL_MINUTES * 60 * 1000),
        },
      });
    }

    // 5. Ask provider to initiate/refresh the charge
    const result = await provider.initiatePayment({ payment: buildProviderPaymentInput(attempt, order, options, provider) });
    assertInitiationAccepted(result, attempt);
    attempt = await tx.payment.update({
      where: { id: attempt.id },
      data: {
        providerRef: result.providerRef || attempt.providerRef,
        status: 'PENDING',
        payload: { method: options.method || null, checkoutUrl: result.checkoutUrl || null },
      },
    });

    await logAudit({
      action: 'PAYMENT_INITIATED',
      entityName: 'Payment',
      entityId: attempt.id,
      details: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        purpose: 'COMMITMENT',
        provider: provider.name,
        providerRef: result.providerRef,
        amountUgx: attempt.amountUgx,
        currency: attempt.currency,
      },
    });

    return { payment: attempt, order, reused: false, initiation: sanitizeInitiation(result) };
  }, PROVIDER_CALL_TX_OPTIONS);
}

// ============================================================
// BALANCE PAYMENT INITIATION (Phase 8)
// Fulfillment completed prerequisite, server-authoritative balance,
// concurrency protected, reusable active attempt.
// ============================================================
async function initiateBalancePayment(userId, orderId, options = {}) {
  const provider = getPaymentProvider(env.PAYMENT_PROVIDER);
  assertProviderAllowed(provider);
  assertMethodSupported(provider, options.method);

  return prisma.$transaction(async (tx) => {
    // 1. Lazy expiry sweep
    await applyPaymentExpiration(tx);

    // 2. Order must exist and belong to this customer
    const order = await tx.order.findFirst({
      where: { id: orderId, userId },
      include: {
        delivery: true,
        user: { select: { id: true, fullName: true, email: true, phone: true } },
      },
    });
    if (!order) {
      throw new AppError('Order not found', 404);
    }
    if (order.currency !== CURRENCY) {
      throw new AppError(`Order currency ${order.currency} is not supported`, 422);
    }

    // 3. Terminal status checks
    if (order.status === 'CANCELLED') {
      throw new AppError('Order has been cancelled and cannot accept balance payment', 409);
    }
    if (order.status === 'COMPLETED') {
      // Check if existing successful balance payment exists
      const existingSuccess = await tx.payment.findFirst({
        where: { orderId: order.id, purpose: 'BALANCE', status: 'SUCCESS' },
        orderBy: { verifiedAt: 'desc' },
      });
      if (existingSuccess) {
        return { payment: existingSuccess, order, reused: true };
      }
      throw new AppError('Order is already completed', 409);
    }

    // 4. Fulfillment eligibility boundary:
    //    Requires DELIVERED status on both order and delivery.
    const delivery = order.delivery;
    if (!delivery) {
      throw new AppError('Fulfillment record not found for this order', 404);
    }

    const isFulfillmentComplete = order.status === 'DELIVERED' && delivery.status === 'DELIVERED';

    if (!isFulfillmentComplete) {
      throw new AppError(
        `Order is not eligible for balance payment. Fulfillment must be completed first ` +
          `(the order must be DELIVERED). Current order status: ${order.status}`,
        409
      );
    }

    // 5. Authoritative balance calculation
    const balance = await calculateOrderBalance(tx, order.id);

    // Check if balance has already been paid
    if (balance.hasSuccessfulBalance) {
      const existingSuccess = await tx.payment.findFirst({
        where: { orderId: order.id, purpose: 'BALANCE', status: 'SUCCESS' },
        orderBy: { verifiedAt: 'desc' },
      });
      return { payment: existingSuccess, order, reused: true, balance };
    }

    // Check if balance due is zero
    if (balance.balanceDueUgx <= 0) {
      throw new AppError('This order has no outstanding balance due', 409);
    }

    // 6. Concurrency lock on order row
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id}::uuid FOR UPDATE`;

    // 7. Idempotent attempt reuse — one active balance attempt per order
    const reusableStatuses = ['PENDING', 'PROCESSING'];
    let attempt = await tx.payment.findFirst({
      where: { orderId: order.id, purpose: 'BALANCE', status: { in: reusableStatuses } },
      orderBy: { createdAt: 'desc' },
    });

    const authoritativeAmount = balance.balanceDueUgx;

    if (!attempt) {
      attempt = await tx.payment.create({
        data: {
          orderId: order.id,
          purpose: 'BALANCE',
          paymentType: 'BALANCE_ONLINE',
          provider: provider.name,
          transactionRef: `PAY-${crypto.randomUUID()}`,
          amountUgx: authoritativeAmount,
          currency: CURRENCY,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + PAYMENT_ATTEMPT_TTL_MINUTES * 60 * 1000),
        },
      });
    } else if (attempt.amountUgx !== authoritativeAmount) {
      // Stale attempt amount: expire it and create fresh
      await tx.payment.update({
        where: { id: attempt.id },
        data: { status: 'EXPIRED', resultCode: 'TIMEOUT', failureMessage: 'Superseded by updated balance attempt' },
      });
      attempt = await tx.payment.create({
        data: {
          orderId: order.id,
          purpose: 'BALANCE',
          paymentType: 'BALANCE_ONLINE',
          provider: provider.name,
          transactionRef: `PAY-${crypto.randomUUID()}`,
          amountUgx: authoritativeAmount,
          currency: CURRENCY,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + PAYMENT_ATTEMPT_TTL_MINUTES * 60 * 1000),
        },
      });
    }

    // 8. Ask provider to initiate/refresh the charge
    const result = await provider.initiatePayment({ payment: buildProviderPaymentInput(attempt, order, options, provider) });
    assertInitiationAccepted(result, attempt);
    attempt = await tx.payment.update({
      where: { id: attempt.id },
      data: {
        providerRef: result.providerRef || attempt.providerRef,
        status: 'PENDING',
        payload: { method: options.method || null, checkoutUrl: result.checkoutUrl || null },
      },
    });

    await logAudit({
      action: 'BALANCE_PAYMENT_INITIATED',
      entityName: 'Payment',
      entityId: attempt.id,
      details: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        purpose: 'BALANCE',
        provider: provider.name,
        providerRef: result.providerRef,
        amountUgx: attempt.amountUgx,
        currency: attempt.currency,
        balanceDueUgx: authoritativeAmount,
      },
    });

    return { payment: attempt, order, balance, reused: false, initiation: sanitizeInitiation(result) };
  }, PROVIDER_CALL_TX_OPTIONS);
}

// ============================================================
// UNIFIED PAYMENT INITIATION DISPATCHER
// ============================================================
async function initiatePayment(userId, orderId, { purpose, method } = {}) {
  if (purpose === 'BALANCE') {
    return initiateBalancePayment(userId, orderId, { method });
  }
  if (purpose === 'COMMITMENT') {
    return initiateCommitmentPayment(userId, orderId, { method });
  }

  // Automatic determination based on current order state
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: { status: true },
  });
  if (!order) {
    throw new AppError('Order not found', 404);
  }

  if (order.status === 'DELIVERED') {
    return initiateBalancePayment(userId, orderId, { method });
  }
  return initiateCommitmentPayment(userId, orderId, { method });
}

// ============================================================
// WEBHOOK PROCESSING (secure, transactional, idempotent)
// Supports both COMMITMENT and BALANCE payment purposes.
// ============================================================
async function processWebhook(rawBody, headers) {
  const provider = getPaymentProvider(env.PAYMENT_PROVIDER);
  assertProviderAllowed(provider);

  // 1. Signature verification + normalization (provider boundary)
  const verification = provider.verifyWebhook({ rawBody, headers });
  if (!verification.ok) {
    await logAudit({
      action: 'PAYMENT_WEBHOOK_REJECTED',
      entityName: 'Payment',
      entityId: 'unknown',
      details: { provider: provider.name, reason: verification.reason },
    });
    throw new AppError('Webhook verification failed', 400);
  }
  if (verification.ignore) {
    // Authentic, but not a payment result (e.g. settlement events): acknowledge.
    logger.info('[payment] webhook event ignored', { provider: provider.name, eventType: verification.eventType });
    return { ignored: true, payment: null, order: null };
  }
  const event = verification.event;

  // 1b. Providers that require it: a success claim is re-confirmed with the
  // provider's authenticated verify API before anything changes. An
  // unconfirmed success is rejected with a retryable error (the provider
  // redelivers) — never applied.
  if (event.outcome === 'SUCCESS' && provider.confirmsSuccessViaApi) {
    const check = await provider.verifyPayment({ providerRef: event.providerRef });
    const confirmed = check && check.ok === true && check.outcome === 'SUCCESS';
    const amountMismatch = confirmed && check.amountUgx !== null && check.amountUgx !== undefined && check.amountUgx !== event.amountUgx;
    const currencyMismatch = confirmed && check.currency && check.currency !== event.currency;
    if (!confirmed || amountMismatch || currencyMismatch) {
      const reason = !confirmed ? 'PROVIDER_VERIFICATION_FAILED' : 'PROVIDER_VERIFICATION_MISMATCH';
      await logAudit({
        action: 'PAYMENT_WEBHOOK_REJECTED',
        entityName: 'Payment',
        entityId: 'unknown',
        details: {
          provider: provider.name,
          providerRef: event.providerRef,
          reason,
          verifyResultCode: (check && check.resultCode) || null,
        },
      });
      throw new AppError(
        confirmed ? 'Webhook does not match the provider transaction' : 'Payment could not be confirmed with the provider yet',
        confirmed ? 422 : 502
      );
    }
    event.apiConfirmed = true;
  }

  return applyProviderEvent(provider, event);
}

// ============================================================
// SERVER-SIDE RECONCILIATION (webhook safety net)
// A webhook can be missed (e.g. a sleeping free-tier host misses JJuma's
// 10-second delivery window). For providers that support it, in-flight
// attempts are re-checked through the provider's authenticated verify API
// whenever the order's payment state is read (the order page polls while a
// payment is in flight). Only an API-confirmed SUCCESS with the exact
// authoritative amount/currency is applied — through the same idempotent
// path as webhooks. Never throws: a provider outage leaves state unchanged.
// ============================================================
async function reconcileOrderPayments(orderId) {
  let provider;
  try {
    provider = getPaymentProvider(env.PAYMENT_PROVIDER);
  } catch {
    return;
  }
  if (!provider.supportsReconciliation || (env.NODE_ENV === 'production' && !provider.isProduction)) return;

  const candidates = await prisma.payment.findMany({
    where: {
      orderId,
      provider: provider.name,
      providerRef: { not: null },
      status: { in: ['PENDING', 'PROCESSING', 'EXPIRED'] },
      // A just-expired attempt can still be paid on the hosted page
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    orderBy: { createdAt: 'desc' },
    take: 3,
  });

  for (const payment of candidates) {
    const last = lastReconcileAt.get(payment.id) || 0;
    if (Date.now() - last < RECONCILE_MIN_INTERVAL_MS) continue;
    lastReconcileAt.set(payment.id, Date.now());
    if (lastReconcileAt.size > 5000) lastReconcileAt.clear();

    try {
      const check = await provider.verifyPayment({ providerRef: payment.providerRef });
      if (!check || check.ok !== true || check.outcome !== 'SUCCESS') continue;
      // The verify response must itself prove the exact amount/currency.
      if (check.amountUgx !== payment.amountUgx || check.currency !== CURRENCY) {
        logger.warn('[payment] reconciliation skipped: provider amount/currency not confirmed', {
          provider: provider.name,
          paymentId: payment.id,
        });
        continue;
      }
      const result = await applyProviderEvent(provider, {
        providerRef: payment.providerRef,
        orderNumber: payment.transactionRef,
        amountUgx: check.amountUgx,
        currency: check.currency,
        outcome: 'SUCCESS',
        purpose: payment.purpose,
        resultCode: 'SUCCESS',
        failureMessage: null,
        occurredAt: new Date().toISOString(),
        apiConfirmed: true,
      });
      if (result && result.verified) {
        logger.info('[payment] attempt settled by reconciliation', { provider: provider.name, paymentId: payment.id });
      }
    } catch (error) {
      logger.warn('[payment] reconciliation check failed', {
        provider: provider.name,
        paymentId: payment.id,
        message: error.message,
      });
    }
  }
}

/**
 * Apply an AUTHENTICATED, normalized provider event to the matching attempt
 * (shared by webhooks and server-side reconciliation): validates it against
 * the authoritative DB state, then transitions payment + order exactly once.
 */
async function applyProviderEvent(provider, event) {
  const postCommitAudits = [];
  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      // 2. Lazy expiry sweep
      await applyPaymentExpiration(tx);

      // 3. Correlate the provider event with internal payment attempt
      let payment = await tx.payment.findFirst({
        where: { provider: provider.name, providerRef: event.providerRef },
        include: {
          order: {
            include: { delivery: true },
          },
        },
      });
      if (!payment && event.orderNumber) {
        // tx_ref fallback (Phase 12 Step 2 §9): Flutterwave's UG mobile-money
        // initiation returns no flw_ref/id, so providerRef may still be null
        // when the FIRST webhook arrives. Resolve the attempt through the
        // UgaMarket transactionRef (sent as tx_ref / JJuma metadata) — then
        // the authoritative providerRef is established below.
        // @@unique([provider, providerRef]) remains untouched.
        payment = await tx.payment.findFirst({
          where: { provider: provider.name, transactionRef: event.orderNumber },
          include: {
            order: {
              include: { delivery: true },
            },
          },
        });
      }
      if (!payment) {
        const err = new AppError('Unknown payment reference', 404);
        err.rejectionAudit = {
          action: 'PAYMENT_WEBHOOK_REJECTED',
          entityName: 'Payment',
          entityId: 'unknown',
          details: { provider: provider.name, providerRef: event.providerRef, reason: 'UNKNOWN_PAYMENT' },
        };
        throw err;
      }

      // 4. Validate event against AUTHORITATIVE internal state
      const reject = (message, statusCode, reason, extra = {}) => {
        const err = new AppError(message, statusCode);
        err.rejectionAudit = {
          action: 'PAYMENT_WEBHOOK_REJECTED',
          entityName: 'Payment',
          entityId: payment.id,
          details: { provider: provider.name, providerRef: event.providerRef, reason, ...extra },
        };
        return err;
      };

      // Events correlated by providerRef may carry no order reference (JJuma
      // without metadata); when one is present it must match.
      if (
        event.orderNumber &&
        payment.order.orderNumber !== event.orderNumber &&
        event.orderNumber !== payment.transactionRef
      ) {
        throw reject('Webhook order reference mismatch', 422, 'ORDER_MISMATCH');
      }
      // A SUCCESS always carries (and must match) amount and currency. A
      // failure moves no money, so a failure event that omits them is still
      // accepted; if present they must match.
      const isSuccess = event.outcome === 'SUCCESS';
      if (isSuccess || event.currency) {
        if (payment.order.currency !== event.currency || event.currency !== CURRENCY) {
          throw reject('Webhook currency mismatch', 422, 'CURRENCY_MISMATCH');
        }
      }
      if (isSuccess || (event.amountUgx !== null && event.amountUgx !== undefined)) {
        if (payment.amountUgx !== event.amountUgx) {
          throw reject('Webhook amount mismatch', 422, 'AMOUNT_MISMATCH');
        }
      }
      if (event.purpose && event.purpose !== payment.purpose) {
        throw reject('Webhook purpose mismatch', 422, 'PURPOSE_MISMATCH');
      }

      // 5. Idempotency & state guards
      if (payment.status === 'SUCCESS') {
        // Duplicate delivery of an already-processed success: acknowledge, change nothing
        return { payment, order: payment.order, duplicate: true };
      }
      // A success the provider's own API has confirmed means money really
      // moved — even when it lands after our attempt expired or after an
      // earlier failure event for the same hosted checkout. It is applied when
      // the order is still payable, otherwise surfaced for staff review;
      // it is never silently dropped.
      const lateConfirmedSuccess =
        event.outcome === 'SUCCESS' && event.apiConfirmed === true && ['FAILED', 'EXPIRED'].includes(payment.status);
      if (!['PENDING', 'PROCESSING'].includes(payment.status) && !lateConfirmedSuccess) {
        // FAILED / CANCELLED / EXPIRED attempts cannot be resurrected by an
        // unconfirmed webhook
        return { payment, order: payment.order, ignored: true };
      }
      if (lateConfirmedSuccess) {
        const payableStatuses = payment.purpose === 'BALANCE' ? ['DELIVERED', 'BALANCE_PAID'] : ['PENDING_PAYMENT'];
        if (!payableStatuses.includes(payment.order.status)) {
          postCommitAudits.push({
            action: 'PAYMENT_RECEIVED_NEEDS_REVIEW',
            entityName: 'Payment',
            entityId: payment.id,
            details: {
              orderId: payment.orderId,
              orderNumber: payment.order.orderNumber,
              purpose: payment.purpose,
              provider: provider.name,
              providerRef: event.providerRef,
              amountUgx: event.amountUgx,
              attemptStatus: payment.status,
              orderStatus: payment.order.status,
            },
          });
          return { payment, order: payment.order, ignored: true, needsReview: true };
        }
      }

      // Check order payable state
      if (payment.order.status === 'CANCELLED') {
        throw reject(`Order is not in a payable state (${payment.order.status})`, 409, 'ORDER_NOT_PAYABLE', {
          orderNumber: payment.order.orderNumber,
          orderStatus: payment.order.status,
        });
      }

      if (payment.purpose === 'COMMITMENT') {
        if (payment.order.status !== 'PENDING_PAYMENT') {
          throw reject(`Order is not in a payable state (${payment.order.status})`, 409, 'ORDER_NOT_PAYABLE', {
            orderNumber: payment.order.orderNumber,
            orderStatus: payment.order.status,
          });
        }
      } else if (payment.purpose === 'BALANCE') {
        // Balance payment eligibility: must be DELIVERED
        if (!['DELIVERED', 'BALANCE_PAID'].includes(payment.order.status)) {
          throw reject(`Order is not eligible for balance payment (${payment.order.status})`, 409, 'ORDER_NOT_PAYABLE', {
            orderNumber: payment.order.orderNumber,
            orderStatus: payment.order.status,
          });
        }
      }

      // 6. Lock attempt row: concurrent webhook deliveries serialize here
      const locked = await tx.$queryRaw`
        SELECT id, status FROM payments WHERE id = ${payment.id}::uuid FOR UPDATE
      `;
      if (locked[0].status === 'SUCCESS') {
        const fresh = await tx.payment.findUnique({
          where: { id: payment.id },
          include: { order: true },
        });
        return { payment: fresh, order: fresh.order, duplicate: true };
      }

      // 7. FAILURE outcome: record it; order remains unpaid for this payment
      if (event.outcome !== 'SUCCESS') {
        const failed = await tx.payment.update({
          where: { id: payment.id },
          data: {
            providerRef: payment.providerRef || event.providerRef,
            status: 'FAILED',
            resultCode: event.resultCode || 'PROVIDER_ERROR',
            failureMessage: event.failureMessage || 'Payment failed',
          },
        });
        postCommitAudits.push({
          action: payment.purpose === 'BALANCE' ? 'BALANCE_PAYMENT_FAILED' : 'PAYMENT_FAILED',
          entityName: 'Payment',
          entityId: payment.id,
          details: {
            orderId: payment.orderId,
            orderNumber: payment.order.orderNumber,
            purpose: payment.purpose,
            providerRef: event.providerRef,
            resultCode: event.resultCode,
          },
        });
        return { payment: failed, order: payment.order, failed: true };
      }

      // 8. SUCCESS outcome:
      const updatedPayment = await tx.payment.update({
        where: { id: payment.id },
        data: {
          // Establish the authoritative providerRef (§9): the first event for
          // an attempt initiated without one (UG momo) creates it here.
          providerRef: payment.providerRef || event.providerRef,
          status: 'SUCCESS',
          resultCode: event.resultCode || 'SUCCESS',
          failureMessage: null,
          verifiedAt: event.occurredAt ? new Date(event.occurredAt) : new Date(),
          // Merge, don't replace: the initiation payload (method rail hint,
          // checkoutUrl) stays available for auditing/reconciliation after
          // the provider event lands.
          payload: {
            ...payment.payload,
            providerEvent: { providerRef: event.providerRef, orderNumber: event.orderNumber, occurredAt: event.occurredAt },
          },
        },
      });

      let updatedOrder;

      if (payment.purpose === 'COMMITMENT') {
        const transition = await applyOrderStatusTransition(tx, {
          orderId: payment.orderId,
          toStatus: 'COMMITMENT_PAID',
          changedByType: 'SYSTEM',
          notes: `Commitment payment verified (${provider.name} ref ${event.providerRef})`,
        });
        updatedOrder = transition.updatedOrder;

        postCommitAudits.push({
          action: 'COMMITMENT_PAYMENT_APPLIED',
          entityName: 'Payment',
          entityId: payment.id,
          details: {
            orderId: payment.orderId,
            orderNumber: payment.order.orderNumber,
            provider: provider.name,
            providerRef: event.providerRef,
            amountUgx: payment.amountUgx,
            currency: payment.currency,
          },
        });
      } else if (payment.purpose === 'BALANCE') {
        // Balance payment success:
        // Invariant guard check
        const guard = await canCompleteOrder(tx, payment.orderId);
        if (!guard.ok) {
          throw reject(`Cannot complete order: ${guard.reason}`, 409, 'COMPLETION_GUARD_FAILED');
        }

        // Apply centralized order status transitions:
        // DELIVERED -> BALANCE_PAID
        if (payment.order.status === 'DELIVERED') {
          await applyOrderStatusTransition(tx, {
            orderId: payment.orderId,
            toStatus: 'BALANCE_PAID',
            changedByType: 'SYSTEM',
            notes: `Balance payment verified (${provider.name} ref ${event.providerRef})`,
          });
        }

        // BALANCE_PAID -> COMPLETED
        const completion = await applyOrderStatusTransition(tx, {
          orderId: payment.orderId,
          toStatus: 'COMPLETED',
          changedByType: 'SYSTEM',
          notes: 'Order completed — balance paid in full and fulfillment verified',
        });
        updatedOrder = completion.updatedOrder;

        // In-app customer notification (persisted in this transaction, pushed live)
        await notifications.notifyCustomer(
          payment.order.userId,
          {
            type: 'ORDER_UPDATE',
            title: 'Order Completed',
            message: `Your balance payment of UGX ${payment.amountUgx.toLocaleString()} was successful. Order ${payment.order.orderNumber} is now complete!`,
            linkUrl: `/account/orders/${payment.orderId}`,
          },
          tx
        );

        postCommitAudits.push({
          action: 'BALANCE_PAYMENT_APPLIED',
          entityName: 'Payment',
          entityId: payment.id,
          details: {
            orderId: payment.orderId,
            orderNumber: payment.order.orderNumber,
            provider: provider.name,
            providerRef: event.providerRef,
            amountUgx: payment.amountUgx,
            currency: payment.currency,
          },
        });

        postCommitAudits.push({
          action: 'ORDER_COMPLETED',
          entityName: 'Order',
          entityId: payment.orderId,
          details: {
            orderId: payment.orderId,
            orderNumber: payment.order.orderNumber,
            totalAmount: payment.order.totalAmount,
            amountPaidUgx: payment.amountUgx,
            completedAt: new Date().toISOString(),
          },
        });
      }

      return { payment: updatedPayment, order: updatedOrder, verified: true };
    });
  } catch (error) {
    if (error.rejectionAudit) {
      await logAudit(error.rejectionAudit);
    }
    throw error;
  }

  for (const audit of postCommitAudits) {
    await logAudit(audit);
  }

  await notifyPaymentOutcome(result);

  return result;
}

/**
 * Post-commit staff + customer notifications for a processed webhook.
 * Duplicates/ignored events notify nobody. Never throws.
 */
async function notifyPaymentOutcome(result) {
  if (result && result.needsReview && result.payment) {
    try {
      const payment = result.payment;
      const order = result.order;
      await notifications.notifyAdmins({
        type: notifications.ADMIN_NOTIFICATION_TYPES.PAYMENT_RECEIVED,
        title: `Payment needs review — ${order.orderNumber}`,
        message: `A ${formatUGX(payment.amountUgx)} ${payment.purpose === 'BALANCE' ? 'balance' : 'deposit'} payment was confirmed by ${payment.provider} after the order moved to ${order.status}. Check the order and refund the customer if it was paid twice.`,
        linkUrl: `/orders/${order.id}`,
        orderId: order.id,
      });
    } catch (error) {
      logger.error('[payment] review notification failed:', error.message);
    }
    return;
  }
  if (!result || result.duplicate || result.ignored || !result.payment) return;
  try {
    const payment = result.payment;
    const order = await prisma.order.findUnique({
      where: { id: payment.orderId },
      select: { id: true, orderNumber: true, userId: true, totalAmount: true, addressSnapshot: true, user: { select: { fullName: true } } },
    });
    if (!order) return;
    const method = (payment.payload && payment.payload.method) || null;
    const methodLabel = method === 'AIRTEL_MONEY' ? 'Airtel Money' : method === 'MTN_MOBILE_MONEY' ? 'MTN MoMo' : 'mobile money';
    const place = order.addressSnapshot ? [order.addressSnapshot.division, order.addressSnapshot.district].filter(Boolean).join(', ') : '';

    if (result.failed) {
      await notifications.notifyCustomer(order.userId, {
        type: 'PAYMENT_UPDATE',
        title: 'Payment not completed',
        message: `Your ${methodLabel} payment of ${formatUGX(payment.amountUgx)} for order ${order.orderNumber} did not go through. You can try again from the order page.`,
        linkUrl: `/account/orders/${order.id}`,
      });
      await notifications.notifyAdmins({
        type: notifications.ADMIN_NOTIFICATION_TYPES.PAYMENT_FAILED,
        title: `Payment failed — ${order.orderNumber}`,
        message: `${order.user.fullName}'s ${methodLabel} payment of ${formatUGX(payment.amountUgx)} failed.`,
        linkUrl: `/orders/${order.id}`,
        orderId: order.id,
      });
      return;
    }

    if (payment.purpose === 'COMMITMENT') {
      await notifications.notifyAdmins({
        type: notifications.ADMIN_NOTIFICATION_TYPES.PAYMENT_RECEIVED,
        title: `Deposit paid — ${order.orderNumber}`,
        message: `${order.user.fullName} paid ${formatUGX(payment.amountUgx)} via ${methodLabel}${place ? ` (delivery to ${place})` : ''}. Confirm and start preparing the order.`,
        linkUrl: `/orders/${order.id}`,
        orderId: order.id,
        metadata: { orderNumber: order.orderNumber, amountUgx: payment.amountUgx, method },
      });
      await notifications.notifyCustomer(order.userId, {
        type: 'PAYMENT_UPDATE',
        title: 'Deposit received',
        message: `We received your deposit of ${formatUGX(payment.amountUgx)} for order ${order.orderNumber}. We will confirm it shortly.`,
        linkUrl: `/account/orders/${order.id}`,
      });
    } else if (payment.purpose === 'BALANCE') {
      await notifications.notifyAdmins({
        type: notifications.ADMIN_NOTIFICATION_TYPES.BALANCE_PAID,
        title: `Balance paid — ${order.orderNumber}`,
        message: `${order.user.fullName} paid the balance of ${formatUGX(payment.amountUgx)} via ${methodLabel}. The order is complete.`,
        linkUrl: `/orders/${order.id}`,
        orderId: order.id,
      });
    }
  } catch (error) {
    logger.error('[payment] outcome notification failed:', error.message);
  }
}

// ============================================================
// CUSTOMER: payment lookup (ownership-enforced, full financial visibility)
// ============================================================
async function getCustomerOrderPayment(userId, orderId) {
  const owned = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: { id: true },
  });
  if (!owned) {
    throw new AppError('Order not found', 404);
  }

  await reconcileOrderPayments(owned.id);
  // Read the order AFTER reconciliation so a just-settled payment is reflected.
  const order = await prisma.order.findUnique({ where: { id: owned.id } });

  const payments = await prisma.payment.findMany({
    where: { orderId: order.id },
    orderBy: { createdAt: 'desc' },
  });

  const balance = await calculateOrderBalance(prisma, order.id);
  const commitmentPayment = payments.find((p) => p.purpose === 'COMMITMENT' && p.status === 'SUCCESS');
  const balancePayment = payments.find((p) => p.purpose === 'BALANCE' && p.status === 'SUCCESS');

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    currency: order.currency,
    pricing: {
      totalUgx: order.totalAmount,
      commitmentUgx: order.commitmentAmount,
      remainingBalanceUgx: balance.balanceDueUgx,
      commitmentPaidUgx: balance.commitmentPaidUgx,
      balancePaidUgx: balance.balancePaidUgx,
      totalPaidUgx: balance.totalPaidUgx,
    },
    commitmentPaymentStatus: commitmentPayment ? 'SUCCESS' : payments.find((p) => p.purpose === 'COMMITMENT')?.status || 'UNPAID',
    balancePaymentStatus: balancePayment
      ? 'SUCCESS'
      : balance.balanceDueUgx === 0
        ? 'NOT_REQUIRED'
        : payments.find((p) => p.purpose === 'BALANCE')?.status || 'UNPAID',
    isFullyPaid: balance.isFullyPaid,
    isCompleted: order.status === 'COMPLETED',
    payments: payments.map(formatPayment),
    activePayment: payments.find((p) => ['PENDING', 'PROCESSING'].includes(p.status)) || null,
  };
}

// ============================================================
// ADMIN: read-only payment visibility (no financial mutation here)
// ============================================================
async function getAdminOrderPayment(orderId) {
  const exists = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } });
  if (exists) {
    await reconcileOrderPayments(exists.id);
  }
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { delivery: true },
  });
  if (!order) {
    throw new AppError('Order not found', 404);
  }
  const payments = await prisma.payment.findMany({
    where: { orderId: order.id },
    orderBy: { createdAt: 'desc' },
  });

  const balance = await calculateOrderBalance(prisma, order.id);

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    currency: order.currency,
    pricing: {
      totalUgx: order.totalAmount,
      commitmentUgx: order.commitmentAmount,
      remainingBalanceUgx: balance.balanceDueUgx,
      commitmentPaidUgx: balance.commitmentPaidUgx,
      balancePaidUgx: balance.balancePaidUgx,
      totalPaidUgx: balance.totalPaidUgx,
    },
    payments: payments.map(formatPayment),
    fulfillment: order.delivery
      ? {
          fulfillmentType: order.delivery.fulfillmentType,
          status: order.delivery.status,
          assignedAdminId: order.delivery.assignedAdminId,
          completedAt: order.delivery.completedAt,
        }
      : null,
  };
}

module.exports = {
  formatPayment,
  calculateOrderBalance,
  canCompleteOrder,
  completeOrderIfEligible,
  initiatePayment,
  initiateCommitmentPayment,
  initiateBalancePayment,
  processWebhook,
  getCustomerOrderPayment,
  getAdminOrderPayment,
  PAYMENT_ATTEMPT_TTL_MINUTES,
  CURRENCY,
};
