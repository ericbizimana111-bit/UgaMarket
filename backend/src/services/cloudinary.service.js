const crypto = require('crypto');
const env = require('../config/env');

/**
 * Minimal Cloudinary client (signed REST API, no SDK dependency).
 *
 * Enabled when CLOUDINARY_URL is set: cloudinary://<api_key>:<api_secret>@<cloud_name>.
 * Stored URLs carry `f_auto,q_auto` so Cloudinary serves WebP/AVIF at an
 * automatic quality — much lighter photos on mobile data.
 */

const DELIVERY_TRANSFORM = 'f_auto,q_auto';

function parseCloudinaryUrl(value) {
  const m = /^cloudinary:\/\/([^:]+):([^@]+)@([^/?#]+)/.exec(String(value || '').trim());
  if (!m) return null;
  return { apiKey: decodeURIComponent(m[1]), apiSecret: decodeURIComponent(m[2]), cloudName: m[3] };
}

function config() {
  return parseCloudinaryUrl(env.CLOUDINARY_URL);
}

function isEnabled() {
  return Boolean(config());
}

/** Cloudinary signature: sha1 of the sorted "k=v&k=v" params + api secret. */
function sign(params, apiSecret) {
  const payload = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(payload + apiSecret).digest('hex');
}

/** Insert the delivery transformation after "/upload/" (idempotent). */
function toDeliveryUrl(secureUrl) {
  if (!secureUrl || secureUrl.includes(`/upload/${DELIVERY_TRANSFORM}/`)) return secureUrl;
  return secureUrl.replace('/upload/', `/upload/${DELIVERY_TRANSFORM}/`);
}

/** True when the URL is an image in THIS Cloudinary account. */
function isCloudinaryUrl(url) {
  const cfg = config();
  return Boolean(cfg && typeof url === 'string' && url.startsWith(`https://res.cloudinary.com/${cfg.cloudName}/image/upload/`));
}

/**
 * public_id from a delivery URL:
 *   https://res.cloudinary.com/<cloud>/image/upload/f_auto,q_auto/v17/ugamarket/abc.jpg
 *   -> "ugamarket/abc"
 */
function publicIdFromUrl(url) {
  const after = String(url).split('/image/upload/')[1];
  if (!after) return null;
  let parts = after.split('?')[0].split('/');
  // Everything before the version segment ("v1712345678") is transformations.
  const version = parts.findIndex((p) => /^v\d+$/.test(p));
  if (version >= 0) parts = parts.slice(version + 1);
  else while (parts.length > 1 && parts[0].includes(',')) parts.shift();
  return decodeURIComponent(parts.join('/').replace(/\.[a-z0-9]+$/i, '')) || null;
}

async function call(endpoint, params, file) {
  const cfg = config();
  if (!cfg) throw new Error('Cloudinary is not configured (CLOUDINARY_URL)');
  const signed = { ...params, timestamp: Math.floor(Date.now() / 1000) };
  const form = new FormData();
  for (const [k, v] of Object.entries(signed)) if (v !== undefined && v !== null && v !== '') form.append(k, String(v));
  form.append('api_key', cfg.apiKey);
  form.append('signature', sign(signed, cfg.apiSecret));
  if (file) form.append('file', new Blob([file.buffer]), file.filename);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloudName}/image/${endpoint}`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new Error(`Cloudinary ${endpoint} failed (${res.status}): ${data?.error?.message || 'unknown error'}`);
  return data;
}

/**
 * Upload an image buffer. With `publicId`, an existing asset is kept as-is
 * (idempotent seeding); otherwise Cloudinary assigns a unique name.
 * Returns the optimized delivery URL.
 */
async function uploadImage(buffer, { filename = 'upload.jpg', publicId } = {}) {
  const data = await call(
    'upload',
    {
      folder: publicId ? undefined : env.CLOUDINARY_FOLDER,
      public_id: publicId ? `${env.CLOUDINARY_FOLDER}/${publicId}` : undefined,
      overwrite: publicId ? 'false' : undefined,
    },
    { buffer, filename }
  );
  return toDeliveryUrl(data.secure_url);
}

/** Delete the asset behind a delivery URL (best effort; returns true if removed). */
async function destroyImage(url) {
  const publicId = publicIdFromUrl(url);
  if (!publicId) return false;
  const data = await call('destroy', { public_id: publicId, invalidate: 'true' });
  return data?.result === 'ok';
}

module.exports = {
  parseCloudinaryUrl,
  isEnabled,
  isCloudinaryUrl,
  sign,
  toDeliveryUrl,
  publicIdFromUrl,
  uploadImage,
  destroyImage,
};
