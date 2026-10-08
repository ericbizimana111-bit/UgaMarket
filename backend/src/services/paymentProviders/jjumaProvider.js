/**
 * JJUMA GLOBAL PAYMENT PROVIDER (active provider)
 *
 * Real provider adapter behind the payment-provider abstraction (see
 * index.js for the contract). JJuma-specific knowledge (endpoints, keys,
 * payload shapes, status strings, webhook signature scheme) is confined to
 * THIS file — payment.service, controllers and routes stay provider-agnostic.
 *
 * Every detail below comes from the official JJuma developer documentation
 * (doc.jjuma.com: Authentication, Create Payment, Webhooks, Node.js guide).
 * Nothing undocumented is assumed; where the docs are silent the adapter
 * takes the conservative path (noted inline).
 *
 * Flow (hosted checkout on pay.jjuma.com):
 *   1. POST {base}/api/v1/payments/create   (Bearer PUBLIC key)
 *        body: { amount, currency, customer_name, customer_phone,
 *                customer_email?, description, external_order_id,
 *                idempotency_key, metadata, redirect_url, cancel_redirect_url }
 *        → { success, status, data: { transaction_id, reference,
 *            payment_url, amount, currency, status: "pending" } }
 *      The customer picks MTN MoMo / Airtel Money on JJuma's hosted page —
 *      the API documents no field to pre-select a network, so UgaMarket's
 *      MTN/Airtel choice is a non-authoritative hint only.
 *   2. Webhook (Dashboard > Tools > Webhooks — NOT a request-level
 *      webhook_url: per the docs those deliveries are NOT signed, so this
 *      adapter never sends one):
 *        headers: X-Jjuma-Signature: sha256=<hex>, X-Jjuma-Timestamp,
 *                 X-Jjuma-Event, X-Jjuma-Delivery-Id
 *        signature = HMAC-SHA256(JJUMA_WEBHOOK_SECRET, timestamp + "." + rawBody)
 *        body: { event, event_id, delivery_id, data: { transaction_id,
 *                reference, amount, currency, status, provider, customer,
 *                metadata } }
 *        events: payment.completed | payment.failed | payment.cancelled
 *   3. GET {base}/api/v1/payments/verify/{transaction_id}  (Bearer SECRET key)
 *        paid ⇔ body.status === "success" && body.data.status === "successful"
 *      Used to confirm every success webhook server-side, and to reconcile
 *      attempts whose webhook was missed (e.g. a sleeping host).
 *
 * Reference mapping:
 *   - Payment.transactionRef ("PAY-<uuid>") → external_order_id,
 *     idempotency_key and metadata.transaction_ref.
 *   - Payment.providerRef ← JJuma data.transaction_id (from the create
 *     response, so webhooks correlate by @@unique([provider, providerRef])).
 *   - Webhook events whose transaction_id is unknown (e.g. an older checkout
 *     page for the same attempt) are resolved through
 *     metadata.transaction_ref, normalized as event.orderNumber.
 *
 * Server-authoritative rule: this adapter NEVER decides that an order is
 * paid. It maps JJuma data into the normalized contract; payment.service
 * re-checks amount, currency, references and state against the database.
 */

const crypto = require('crypto');
const env = require('../../config/env');

const API_PREFIX = '/api/v1';
const CHECKOUT_HOST = 'pay.jjuma.com';
// Measured against api.jjuma.com (Oct 2026): create answers in ~1 s, but
// GET /payments/verify routinely takes 20-50 s. A shorter verify timeout makes
// every webhook confirmation and reconciliation check fail, so a paid order
// would never be marked paid. Create stays short: it runs inside the order
// lock (see PROVIDER_CALL_TX_OPTIONS in payment.service).
const CREATE_TIMEOUT_MS = 20000;
const VERIFY_TIMEOUT_MS = 60000;
// Official Node.js guide rejects webhook timestamps older/newer than 5 min.
const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;
const SUPPORTED_METHODS = new Set(['MTN_MOBILE_MONEY', 'AIRTEL_MONEY']);

// Webhook event → normalized outcome (documented event names).
const OUTCOME_BY_EVENT = {
  'payment.completed': { outcome: 'SUCCESS', resultCode: 'SUCCESS', failureMessage: null },
  'payment.failed': { outcome: 'FAILED', resultCode: 'DECLINED', failureMessage: 'Payment was not completed at JJuma' },
  'payment.cancelled': { outcome: 'FAILED', resultCode: 'CANCELLED_BY_USER', failureMessage: 'Payment was cancelled at JJuma' },
};

// Terminal transaction states reported by the verify API (data.status /
// data.payment_status, the same values the hosted page and the webhook
// payloads use). Anything else (pending, processing, …) stays PENDING.
const OUTCOME_BY_VERIFY_STATUS = {
  failed: OUTCOME_BY_EVENT['payment.failed'],
  cancelled: OUTCOME_BY_EVENT['payment.cancelled'],
  canceled: OUTCOME_BY_EVENT['payment.cancelled'],
  expired: { outcome: 'FAILED', resultCode: 'TIMEOUT', failureMessage: 'Payment expired at JJuma' },
};

// Documented JJuma error codes → customer-safe explanations. The raw provider
// message is logged server-side only.
const CREATE_ERROR_MESSAGES = {
  VERIFICATION_REQUIRED: 'The payment provider has not activated this merchant account yet',
  AUTH_REQUIRED: 'The payment provider rejected the merchant credentials',
  INVALID_API_KEY: 'The payment provider rejected the merchant credentials',
  PROVIDER_UNAVAILABLE: 'The payment provider is temporarily unavailable',
  INVALID_AMOUNT: 'The payment provider rejected the payment amount',
  INVALID_CURRENCY: 'The payment provider does not accept this currency',
  INVALID_EMAIL: 'The payment provider rejected the customer email address',
  INVALID_URL: 'The payment provider rejected the return address',
};

// ──────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────

function apiBaseUrl() {
  return String(env.JJUMA_API_BASE_URL || 'https://api.jjuma.com').trim().replace(/\/+$/, '');
}

function providerError(message, extra = {}) {
  const error = new Error(message);
  error.isProviderError = true;
  Object.assign(error, extra);
  return error;
}

/**
 * Thin isolated HTTPS JSON client (no SDK dependency; TLS verification stays
 * enabled). Keys are only ever placed in the Authorization header.
 */
async function jjumaRequest(method, path, { accessKey, body, timeoutMs = CREATE_TIMEOUT_MS } = {}) {
  const url = `${apiBaseUrl()}${API_PREFIX}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessKey}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      throw providerError(`JJuma API error (HTTP ${response.status})`, {
        httpStatus: response.status,
        ...providerErrorDetails(parsed),
      });
    }
    return parsed;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw providerError('JJuma API request timed out', { timeout: true });
    }
    if (error.isProviderError) throw error;
    throw providerError('JJuma API unreachable');
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Documented error body: { success:false, status:"error", message, code,
 * request_id }. Only short, printable excerpts are kept, for server logs.
 */
function providerErrorDetails(parsed) {
  const clip = (value, max) =>
    typeof value === 'string' && value.trim() ? value.replace(/[^\x20-\x7E]/g, ' ').trim().slice(0, max) : null;
  return {
    providerCode: parsed ? clip(parsed.code, 60) : null,
    providerMessage: parsed ? clip(parsed.message, 200) : null,
    providerRequestId: parsed ? clip(parsed.request_id, 80) : null,
  };
}

/** Wrap provider/network failures into a normalized { ok:false, … } result. */
function toFailureResult(error) {
  if (error && error.timeout) {
    return { ok: false, outcome: 'FAILED', resultCode: 'TIMEOUT', failureMessage: 'Payment provider timed out' };
  }
  if (error && error.httpStatus === 404) {
    return {
      ok: false,
      outcome: 'FAILED',
      resultCode: 'INVALID_REFERENCE',
      failureMessage: 'Payment provider has no transaction for this reference',
      httpStatus: 404,
    };
  }
  const providerCode = (error && error.providerCode) || null;
  return {
    ok: false,
    outcome: 'FAILED',
    resultCode: 'PROVIDER_ERROR',
    failureMessage:
      (providerCode && CREATE_ERROR_MESSAGES[providerCode]) ||
      (error && error.httpStatus ? 'Payment provider error' : 'Payment provider unavailable'),
    httpStatus: (error && error.httpStatus) || null,
    providerCode,
    providerMessage: (error && error.providerMessage) || null,
    providerRequestId: (error && error.providerRequestId) || null,
  };
}

function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function rawBodyToString(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody.toString('utf8');
  if (typeof rawBody === 'string') return rawBody;
  return null;
}

/**
 * Parse X-Jjuma-Timestamp. The official example parses it with `new Date()`;
 * numeric epoch values (seconds or milliseconds) are accepted too. The raw
 * header string is what gets signed, so parsing only gates freshness.
 */
function parseWebhookTimestamp(value) {
  const text = String(value || '').trim();
  if (!text) return NaN;
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n < 1e12 ? n * 1000 : n;
  }
  return new Date(text).getTime();
}

function header(headers, name) {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : '';
}

function toIntegerAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

function isTrustedCheckoutUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && url.hostname === CHECKOUT_HOST;
  } catch {
    return false;
  }
}

function returnUrls(payment) {
  if (!payment.returnUrl) return {};
  return { redirect_url: payment.returnUrl, cancel_redirect_url: payment.returnUrl };
}

// ──────────────────────────────────────────────────────────────────────────
// Provider contract implementation
// ──────────────────────────────────────────────────────────────────────────

module.exports = {
  name: 'JJUMA',
  isProduction: true,
  // Success webhooks are re-confirmed through the secret-key verify API, and
  // pending attempts can be reconciled through it when a webhook is missed.
  confirmsSuccessViaApi: true,
  supportsReconciliation: true,
  // JJuma only requires customer_name; email is optional (unlike Flutterwave).
  requiresCustomerEmail: false,

  /**
   * Create a hosted JJuma checkout session for the attempt.
   *
   * payment: { transactionRef, amountUgx, currency, purpose, method?,
   *            orderNumber?, returnUrl?, customer: { fullName?, email?, phoneE164 } }
   * Returns { ok:true, providerRef, checkoutUrl, outcome:'PENDING', resultCode:'NONE' }
   *      or { ok:false, outcome:'FAILED', resultCode, failureMessage, httpStatus? }.
   */
  async initiatePayment({ payment } = {}) {
    if (!env.JJUMA_PUBLIC_KEY) {
      return {
        ok: false,
        outcome: 'FAILED',
        resultCode: 'PROVIDER_ERROR',
        failureMessage: 'JJuma is not configured (JJUMA_PUBLIC_KEY missing)',
      };
    }
    if (payment.method && !SUPPORTED_METHODS.has(payment.method)) {
      return {
        ok: false,
        outcome: 'FAILED',
        resultCode: 'INVALID_REFERENCE',
        failureMessage: `Unsupported payment method for JJuma: ${payment.method}`,
      };
    }
    if (!Number.isInteger(payment.amountUgx) || payment.amountUgx <= 0) {
      return { ok: false, outcome: 'FAILED', resultCode: 'INVALID_REFERENCE', failureMessage: 'Invalid payment amount' };
    }
    const customer = payment.customer || {};

    const purposeLabel = payment.purpose === 'BALANCE' ? 'balance' : 'deposit';
    const body = {
      amount: payment.amountUgx,
      currency: payment.currency || 'UGX',
      customer_name: customer.fullName || 'UgaMarket customer',
      ...(customer.phoneE164 ? { customer_phone: customer.phoneE164 } : {}),
      ...(customer.email ? { customer_email: customer.email } : {}),
      description: `UgaMarket order ${payment.orderNumber || ''} ${purposeLabel}`.replace(/\s+/g, ' ').trim(),
      external_order_id: payment.transactionRef,
      idempotency_key: payment.transactionRef,
      metadata: {
        transaction_ref: payment.transactionRef,
        ...(payment.orderNumber ? { order_number: payment.orderNumber } : {}),
        purpose: payment.purpose || null,
      },
      ...returnUrls(payment),
    };

    let response;
    try {
      response = await jjumaRequest('POST', '/payments/create', { accessKey: env.JJUMA_PUBLIC_KEY, body });
    } catch (error) {
      return toFailureResult(error);
    }

    const data = response && typeof response.data === 'object' && response.data ? response.data : null;
    if (!response || response.success !== true || !data || !data.transaction_id) {
      const details = providerErrorDetails(response);
      return {
        ok: false,
        outcome: 'FAILED',
        resultCode: 'PROVIDER_ERROR',
        failureMessage: (details.providerCode && CREATE_ERROR_MESSAGES[details.providerCode]) || 'Payment provider rejected the payment request',
        ...details,
      };
    }
    // payment_url is documented; current responses also echo checkout_url.
    const checkoutUrl = data.payment_url || data.checkout_url;
    if (!isTrustedCheckoutUrl(checkoutUrl)) {
      // Official guidance: validate checkout redirect domains.
      return {
        ok: false,
        outcome: 'FAILED',
        resultCode: 'PROVIDER_ERROR',
        failureMessage: 'Payment provider returned an untrusted checkout URL',
      };
    }
    // Defensive echo check: the session JJuma created must be for exactly the
    // server-authoritative amount/currency (fields present in the response).
    const echoedAmount = toIntegerAmount(data.amount);
    if (echoedAmount !== null && echoedAmount !== payment.amountUgx) {
      return { ok: false, outcome: 'FAILED', resultCode: 'PROVIDER_ERROR', failureMessage: 'Payment provider amount mismatch' };
    }
    if (data.currency && String(data.currency).toUpperCase() !== String(body.currency).toUpperCase()) {
      return { ok: false, outcome: 'FAILED', resultCode: 'PROVIDER_ERROR', failureMessage: 'Payment provider currency mismatch' };
    }

    return {
      ok: true,
      providerRef: String(data.transaction_id),
      checkoutUrl: String(checkoutUrl),
      outcome: 'PENDING',
      resultCode: 'NONE',
    };
  },

  /**
   * Ask JJuma (secret key) for the authoritative state of a transaction.
   *
   * Returns { ok:true, providerRef, outcome, amountUgx|null, currency|null,
   * providerStatus } where outcome is 'SUCCESS' only for the documented paid
   * shape, 'FAILED' when JJuma itself reports the transaction as failed /
   * cancelled / expired, and 'PENDING' for everything else. A verify call can
   * therefore close a dead attempt (so the customer is not left waiting when
   * the dashboard webhook is missed) but never invents a success.
   */
  async verifyPayment({ providerRef } = {}) {
    if (!env.JJUMA_SECRET_KEY) {
      return {
        ok: false,
        outcome: 'FAILED',
        resultCode: 'PROVIDER_ERROR',
        failureMessage: 'JJuma is not configured (JJUMA_SECRET_KEY missing)',
      };
    }
    if (!providerRef) {
      return {
        ok: false,
        outcome: 'FAILED',
        resultCode: 'INVALID_REFERENCE',
        failureMessage: 'No JJuma transaction id available for verification',
      };
    }

    let response;
    try {
      response = await jjumaRequest('GET', `/payments/verify/${encodeURIComponent(String(providerRef))}`, {
        accessKey: env.JJUMA_SECRET_KEY,
        timeoutMs: VERIFY_TIMEOUT_MS,
      });
    } catch (error) {
      return toFailureResult(error);
    }

    const data = response && typeof response.data === 'object' && response.data ? response.data : null;
    if (!response || !data) {
      return {
        ok: false,
        outcome: 'FAILED',
        resultCode: 'PROVIDER_ERROR',
        failureMessage: 'Payment provider returned no transaction data',
      };
    }
    if (data.transaction_id && String(data.transaction_id) !== String(providerRef)) {
      return {
        ok: false,
        outcome: 'FAILED',
        resultCode: 'INVALID_REFERENCE',
        failureMessage: 'Payment provider returned a different transaction',
      };
    }

    const status = String(data.status || '').toLowerCase();
    const paid = response.status === 'success' && status === 'successful';
    // Only trust a terminal failure when both status fields agree (when the
    // second one is present), so a half-updated record is never closed early.
    const paymentStatus = data.payment_status ? String(data.payment_status).toLowerCase() : status;
    const terminal = !paid && response.status === 'success' && paymentStatus === status ? OUTCOME_BY_VERIFY_STATUS[status] : null;
    return {
      ok: true,
      providerRef: String(providerRef),
      outcome: paid ? 'SUCCESS' : terminal ? terminal.outcome : 'PENDING',
      resultCode: paid ? 'SUCCESS' : terminal ? terminal.resultCode : 'NONE',
      failureMessage: terminal ? terminal.failureMessage : null,
      amountUgx: toIntegerAmount(data.amount),
      currency: data.currency ? String(data.currency).toUpperCase() : null,
      providerStatus: status.slice(0, 40) || null,
    };
  },

  /**
   * Validate a dashboard webhook delivery and normalize it.
   * Returns { ok:true, event } | { ok:true, ignore:true, eventType }
   *       | { ok:false, reason } — never throws.
   */
  verifyWebhook(options = {}) {
    const { rawBody, headers } = options || {};
    const raw = rawBodyToString(rawBody);
    if (!raw || !headers || typeof headers !== 'object') {
      return { ok: false, reason: 'MISSING_PAYLOAD' };
    }

    const secret = String(env.JJUMA_WEBHOOK_SECRET || '');
    const supplied = header(headers, 'x-jjuma-signature').trim().replace(/^sha256=/i, '');
    const timestamp = header(headers, 'x-jjuma-timestamp').trim();
    if (!supplied || !timestamp) {
      return { ok: false, reason: 'MISSING_SIGNATURE' };
    }
    if (!secret) {
      return { ok: false, reason: 'INVALID_SIGNATURE' };
    }

    const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
    if (!timingSafeEqualHex(expected, supplied.toLowerCase())) {
      return { ok: false, reason: 'INVALID_SIGNATURE' };
    }

    const eventTime = parseWebhookTimestamp(timestamp);
    if (!Number.isFinite(eventTime) || Math.abs(Date.now() - eventTime) > WEBHOOK_TOLERANCE_MS) {
      return { ok: false, reason: 'STALE_TIMESTAMP' };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'MALFORMED_PAYLOAD' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'MALFORMED_PAYLOAD' };
    }

    const eventType = String(parsed.event || '').trim();
    const mapped = OUTCOME_BY_EVENT[eventType];
    if (!mapped) {
      // settlement.*, withdrawal.paid, payment.started … are not payment
      // results for UgaMarket: acknowledge without touching any record.
      return { ok: true, ignore: true, eventType: eventType.slice(0, 60) || 'unknown' };
    }

    const data = parsed.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, reason: 'MALFORMED_PAYLOAD' };
    }
    const providerRef = data.transaction_id ? String(data.transaction_id) : '';
    if (!providerRef || providerRef.length > 150) {
      return { ok: false, reason: 'MALFORMED_PAYLOAD' };
    }

    const amountUgx = data.amount === undefined || data.amount === null ? null : toIntegerAmount(data.amount);
    const currency = data.currency ? String(data.currency).toUpperCase() : null;
    if (mapped.outcome === 'SUCCESS') {
      // A success must carry the exact amount and currency to be checked.
      if (amountUgx === null || amountUgx <= 0 || currency !== 'UGX') {
        return { ok: false, reason: 'MALFORMED_PAYLOAD' };
      }
    } else if ((data.amount !== undefined && data.amount !== null && amountUgx === null) || (currency && currency !== 'UGX')) {
      // Failure payloads are only documented by event name; if they do carry
      // amount/currency, they must still be well-formed UGX values.
      return { ok: false, reason: 'MALFORMED_PAYLOAD' };
    }

    const metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
    const transactionRef =
      typeof metadata.transaction_ref === 'string' && metadata.transaction_ref.length <= 150 ? metadata.transaction_ref : null;

    return {
      ok: true,
      event: {
        providerRef,
        orderNumber: transactionRef, // correlation fallback resolved by payment.service
        amountUgx,
        currency,
        outcome: mapped.outcome,
        purpose: null,
        resultCode: mapped.resultCode,
        failureMessage: mapped.failureMessage,
        occurredAt: new Date(eventTime).toISOString(),
        deliveryId: String(parsed.delivery_id || header(headers, 'x-jjuma-delivery-id') || '').slice(0, 100) || null,
      },
    };
  },
};
