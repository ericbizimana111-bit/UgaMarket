const env = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * Outbound email and SMS.
 *
 * Providers (chosen by EMAIL_PROVIDER / SMS_PROVIDER):
 *   Email: SMTP (any mailbox: Gmail app password, Zoho, Brevo SMTP...),
 *          RESEND (HTTPS API), LOG (development only: printed to the console).
 *   SMS:   AFRICASTALKING (Uganda: MTN + Airtel), LOG (development only).
 *
 * Every send resolves to { status, providerRef, error } and never throws:
 *   SENT     the provider accepted the message (delivery may still fail;
 *            Africa's Talking reports the final result to the delivery-report
 *            webhook, see routes/messaging.routes.js)
 *   FAILED   the provider refused it or could not be reached
 *   LOGGED   development LOG provider: nothing left the server
 *
 * Message bodies (which may contain verification codes) are only ever
 * printed by the LOG provider, and the LOG provider never prints in
 * production.
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
  if (env.EMAIL_PROVIDER === 'RESEND' && env.RESEND_API_KEY && env.EMAIL_FROM) return 'RESEND';
  return 'LOG';
}

/** True when a real email provider is configured (not the console logger). */
function emailConfigured() {
  return emailProvider() !== 'LOG';
}

async function sendEmail({ to, subject, text, html, headers = {} }) {
  const provider = emailProvider();
  try {
    if (provider === 'SMTP') {
      const info = await getSmtpTransport().sendMail({ from: env.EMAIL_FROM, to, subject, text, html, headers });
      const accepted = Array.isArray(info.accepted) && info.accepted.length > 0;
      return accepted
        ? { status: 'SENT', providerRef: String(info.messageId || '').slice(0, 150) || null }
        : { status: 'FAILED', providerRef: null, error: 'Recipient rejected by the mail server' };
    }

    if (provider === 'RESEND') {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text, html, headers }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { status: 'FAILED', providerRef: null, error: data?.message || `Resend HTTP ${res.status}` };
      return { status: 'SENT', providerRef: data.id ? String(data.id).slice(0, 150) : null };
    }

    // LOG
    if (isProduction()) {
      logger.error(`[email] No email provider is configured (EMAIL_PROVIDER). Message "${subject}" was NOT sent.`);
      return { status: 'FAILED', providerRef: null, error: 'Email delivery is not configured' };
    }
    if (env.NODE_ENV !== 'test') {
      logger.info(`[email:LOG] to=${to} subject="${subject}"\n${text}`);
    }
    return { status: 'LOGGED', providerRef: null };
  } catch (error) {
    logger.error(`[email] ${provider} send failed: ${error.message}`);
    return { status: 'FAILED', providerRef: null, error: 'Email provider unavailable' };
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

module.exports = {
  sendEmail,
  sendSms,
  emailConfigured,
  smsConfigured,
  emailProvider,
  smsProvider,
  maskTarget,
};
