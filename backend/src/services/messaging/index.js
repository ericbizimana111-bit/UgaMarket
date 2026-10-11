const env = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * Outbound email and SMS.
 *
 * Providers (chosen by EMAIL_PROVIDER / SMS_PROVIDER):
 *   Email: BREVO (HTTPS API), RESEND (HTTPS API), SMTP (any mailbox; NOT on
 *          Render free, which blocks SMTP ports 25/465/587),
 *          LOG (development only: printed to the console).
 *   SMS:   AFRICASTALKING (Uganda: MTN + Airtel), LOG (development only).
 *
 * Every send resolves to { status, providerRef, error } and never throws:
 *   SENT     the provider accepted the message (delivery may still fail;
 *            Africa's Talking reports the final result to the delivery-report
 *            webhook, see routes/messaging.routes.js)
 *   FAILED   the provider refused it or could not be reached; `error` is a
 *            short reason code (e.g. SMTP_UNREACHABLE_ETIMEDOUT, BREVO_HTTP_401)
 *   LOGGED   development LOG provider: nothing left the server
 *
 * Message bodies (which may contain verification codes) are only ever
 * printed by the LOG provider, and the LOG provider never prints in
 * production. Diagnostic logs carry the operation, the masked recipient and
 * a reason code, never credentials, codes or message bodies.
 */

const isProduction = () => env.NODE_ENV === 'production';

// ------------------------------------------------------------
// Email
// ------------------------------------------------------------
let smtpTransport = null;
function getSmtpTransport() {
  if (!smtpTransport) {
    // Lazy require: nodemailer is only loaded when SMTP is actually used.
    const nodemailer = require('nodemailer');
    smtpTransport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }
  return smtpTransport;
}

function emailProvider() {
  if (env.EMAIL_PROVIDER === 'SMTP' && env.SMTP_HOST && env.EMAIL_FROM) return 'SMTP';
  if (env.EMAIL_PROVIDER === 'BREVO' && env.BREVO_API_KEY && env.EMAIL_FROM) return 'BREVO';
  if (env.EMAIL_PROVIDER === 'RESEND' && env.RESEND_API_KEY && env.EMAIL_FROM) return 'RESEND';
  return 'LOG';
}

/** True when a real email provider is configured (not the console logger). */
function emailConfigured() {
  return emailProvider() !== 'LOG';
}

/** '"UgaMarket" <a@b.c>' / 'UgaMarket <a@b.c>' / 'a@b.c' -> { name, email }. */
function parseAddress(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^"?([^"<]*?)"?\s*<\s*([^>\s]+)\s*>$/);
  if (match) return { name: match[1].trim() || undefined, email: match[2] };
  return { name: undefined, email: raw };
}

const SMTP_NETWORK_CODES = new Set(['ETIMEDOUT', 'ECONNECTION', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ESOCKET', 'EDNS', 'ENOTFOUND']);

/**
 * A short, safe reason for a failed send: error codes and status numbers
 * only, never the message, the code inside it, or any credential.
 */
function describeEmailError(provider, error) {
  if (provider === 'SMTP') {
    const code = error?.code || 'UNKNOWN';
    if (code === 'EAUTH') {
      return { reason: 'SMTP_AUTH_REJECTED', hint: 'The mail server rejected SMTP_USER / SMTP_PASS (for Gmail use a 16-letter App Password).' };
    }
    if (SMTP_NETWORK_CODES.has(code)) {
      return {
        reason: `SMTP_UNREACHABLE_${code}`,
        hint: `Could not connect to ${env.SMTP_HOST}:${env.SMTP_PORT}. Render free instances block outbound SMTP ports 25/465/587: use EMAIL_PROVIDER=BREVO or RESEND.`,
      };
    }
    return { reason: `SMTP_${code}${error?.responseCode ? `_${error.responseCode}` : ''}`, hint: '' };
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return { reason: `${provider}_TIMEOUT`, hint: '' };
  return { reason: `${provider}_NETWORK_${error?.cause?.code || error?.code || 'ERROR'}`, hint: '' };
}

/** HTTP API failure -> safe reason (status + provider error code, not the payload). */
async function apiFailure(provider, res) {
  const data = await res.json().catch(() => ({}));
  const code = String(data?.code || data?.name || '').replace(/[^\w-]/g, '').slice(0, 40);
  const hints = {
    400: provider === 'BREVO' ? 'Brevo refused the message: EMAIL_FROM must be a sender verified in Brevo (Senders & IP > Senders).' : '',
    401: `${provider} rejected the API key (check ${provider}_API_KEY).`,
    403: `${provider} refused the request (account not activated yet, or an IP restriction on the key).`,
  };
  return { reason: `${provider}_HTTP_${res.status}${code ? `_${code}` : ''}`, hint: hints[res.status] || '' };
}

function logEmailFailure({ provider, tag, to, reason, hint }) {
  logger.error(`[email] send failed provider=${provider} op=${tag || 'email'} to=${maskTarget(to)} reason=${reason}${hint ? ` | ${hint}` : ''}`);
}

function logEmailSent(provider, tag, to) {
  if (env.NODE_ENV !== 'test') logger.info(`[email] sent provider=${provider} op=${tag || 'email'} to=${maskTarget(to)}`);
}

/**
 * Send an email. `tag` names the operation (e.g. "otp:PASSWORD_RESET") in
 * the diagnostic logs.
 */
async function sendEmail({ to, subject, text, html, headers = {}, tag }) {
  const provider = emailProvider();
  try {
    if (provider === 'SMTP') {
      const info = await getSmtpTransport().sendMail({ from: env.EMAIL_FROM, to, subject, text, html, headers });
      const accepted = Array.isArray(info.accepted) && info.accepted.length > 0;
      if (!accepted) {
        logEmailFailure({ provider, tag, to, reason: 'SMTP_RECIPIENT_REJECTED' });
        return { status: 'FAILED', providerRef: null, error: 'SMTP_RECIPIENT_REJECTED' };
      }
      logEmailSent(provider, tag, to);
      return { status: 'SENT', providerRef: String(info.messageId || '').slice(0, 150) || null };
    }

    if (provider === 'BREVO') {
      const sender = parseAddress(env.EMAIL_FROM);
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': env.BREVO_API_KEY, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: sender.name ? sender : { email: sender.email },
          to: [{ email: to }],
          subject,
          htmlContent: html,
          textContent: text,
          ...(Object.keys(headers).length > 0 && { headers }),
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const failure = await apiFailure(provider, res);
        logEmailFailure({ provider, tag, to, ...failure });
        return { status: 'FAILED', providerRef: null, error: failure.reason };
      }
      const data = await res.json().catch(() => ({}));
      logEmailSent(provider, tag, to);
      return { status: 'SENT', providerRef: data.messageId ? String(data.messageId).slice(0, 150) : null };
    }

    if (provider === 'RESEND') {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text, html, headers }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const failure = await apiFailure(provider, res);
        logEmailFailure({ provider, tag, to, ...failure });
        return { status: 'FAILED', providerRef: null, error: failure.reason };
      }
      const data = await res.json().catch(() => ({}));
      logEmailSent(provider, tag, to);
      return { status: 'SENT', providerRef: data.id ? String(data.id).slice(0, 150) : null };
    }

    // LOG
    if (isProduction()) {
      logEmailFailure({ provider, tag, to, reason: 'NOT_CONFIGURED', hint: 'Set EMAIL_PROVIDER (BREVO, RESEND or SMTP) and EMAIL_FROM.' });
      return { status: 'FAILED', providerRef: null, error: 'NOT_CONFIGURED' };
    }
    if (env.NODE_ENV !== 'test') {
      logger.info(`[email:LOG] to=${to} subject="${subject}"\n${text}`);
    }
    return { status: 'LOGGED', providerRef: null };
  } catch (error) {
    const failure = describeEmailError(provider, error);
    logEmailFailure({ provider, tag, to, ...failure });
    return { status: 'FAILED', providerRef: null, error: failure.reason };
  }
}

/**
 * Check that the configured email provider is reachable and accepts our
 * credentials, without sending anything. Runs at startup so a broken setup
 * shows in the logs straight away. Resolves to { ok, provider, reason, hint }.
 */
async function verifyEmailProvider() {
  const provider = emailProvider();
  try {
    if (provider === 'SMTP') {
      await getSmtpTransport().verify();
      return { ok: true, provider };
    }
    if (provider === 'BREVO') {
      const res = await fetch('https://api.brevo.com/v3/account', {
        headers: { 'api-key': env.BREVO_API_KEY, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return { ok: false, provider, ...(await apiFailure(provider, res)) };
      return { ok: true, provider };
    }
    // Resend send-only keys cannot call read endpoints, so there is nothing safe to probe.
    if (provider === 'RESEND') return { ok: true, provider, reason: 'NOT_CHECKED' };
    return { ok: !isProduction(), provider, reason: 'NOT_CONFIGURED' };
  } catch (error) {
    return { ok: false, provider, ...describeEmailError(provider, error) };
  }
}

// ------------------------------------------------------------
// SMS
// ------------------------------------------------------------
function smsProvider() {
  if (env.SMS_PROVIDER === 'AFRICASTALKING' && env.AT_USERNAME && env.AT_API_KEY) return 'AFRICASTALKING';
  return 'LOG';
}

/** True when a real SMS provider is configured (not the console logger). */
function smsConfigured() {
  return smsProvider() !== 'LOG';
}

// Africa's Talking per-recipient status codes that mean "accepted".
const AT_ACCEPTED = new Set([100, 101, 102]);

async function sendSms(to, message) {
  const provider = smsProvider();
  try {
    if (provider === 'AFRICASTALKING') {
      const sandbox = env.AT_USERNAME === 'sandbox';
      const url = sandbox
        ? 'https://api.sandbox.africastalking.com/version1/messaging'
        : 'https://api.africastalking.com/version1/messaging';
      const form = new URLSearchParams({ username: env.AT_USERNAME, to, message });
      if (env.AT_SENDER_ID) form.set('from', env.AT_SENDER_ID);
      const res = await fetch(url, {
        method: 'POST',
        headers: { apiKey: env.AT_API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json().catch(() => null);
      const recipient = data?.SMSMessageData?.Recipients?.[0];
      if (!res.ok || !recipient) {
        return { status: 'FAILED', providerRef: null, error: data?.SMSMessageData?.Message || `Africa's Talking HTTP ${res.status}` };
      }
      if (!AT_ACCEPTED.has(Number(recipient.statusCode))) {
        return { status: 'FAILED', providerRef: recipient.messageId || null, error: recipient.status || 'Rejected' };
      }
      return { status: 'SENT', providerRef: recipient.messageId ? String(recipient.messageId).slice(0, 150) : null };
    }

    // LOG
    if (isProduction()) {
      logger.error('[sms] No SMS provider is configured (SMS_PROVIDER). Message was NOT sent.');
      return { status: 'FAILED', providerRef: null, error: 'SMS delivery is not configured' };
    }
    if (env.NODE_ENV !== 'test') {
      logger.info(`[sms:LOG] to=${to}\n${message}`);
    }
    return { status: 'LOGGED', providerRef: null };
  } catch (error) {
    logger.error(`[sms] ${provider} send failed: ${error.message}`);
    return { status: 'FAILED', providerRef: null, error: 'SMS provider unavailable' };
  }
}

/** Mask a destination for logs and UI: "+25677*****23", "jo***@gmail.com". */
function maskTarget(target) {
  const value = String(target || '');
  if (value.includes('@')) {
    const [local, domain] = value.split('@');
    return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
  }
  if (value.length <= 6) return '***';
  return `${value.slice(0, 6)}${'*'.repeat(Math.max(3, value.length - 8))}${value.slice(-2)}`;
}

/** Test hook: forget the cached SMTP transport. */
function resetTransports() {
  smtpTransport = null;
}

module.exports = {
  sendEmail,
  sendSms,
  emailConfigured,
  smsConfigured,
  emailProvider,
  verifyEmailProvider,
  smsProvider,
  maskTarget,
  parseAddress,
  resetTransports,
};
