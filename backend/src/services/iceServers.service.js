const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * ICE servers for voice calls.
 *
 * STUN lets two browsers find a direct path. On many mobile networks, hotel
 * Wi‑Fi and office firewalls a direct path is impossible, and the call needs
 * a TURN relay — the difference between "works on my Wi‑Fi" and "works from
 * any network in any country". Supported, first match wins:
 *
 *   1. Cloudflare Realtime TURN  (global anycast network, ~330 cities)
 *        CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN
 *        Short-lived credentials are minted through Cloudflare's API.
 *   2. Your own coturn server with a shared secret ("use-auth-secret")
 *        TURN_URLS + TURN_SECRET -> time-limited HMAC credentials
 *   3. Static TURN credentials (any provider)
 *        TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL
 *
 * Credentials are never long-lived: browsers only ever receive credentials
 * that expire after TURN_TTL_SECONDS.
 */

const split = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

let cloudflareCache = null; // { servers, expiresAt }

async function cloudflareServers() {
  if (cloudflareCache && cloudflareCache.expiresAt > Date.now()) return cloudflareCache.servers;
  const ttl = env.TURN_TTL_SECONDS;
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.CLOUDFLARE_TURN_KEY_ID)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Cloudflare TURN HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
  if (!list.length) throw new Error('Cloudflare TURN returned no servers');
  // Re-use for half the credential lifetime so every call still has ample time.
  cloudflareCache = { servers: list, expiresAt: Date.now() + (ttl * 1000) / 2 };
  return list;
}

/** coturn "use-auth-secret" (TURN REST API) credentials. */
function coturnServers(identity) {
  const expiry = Math.floor(Date.now() / 1000) + env.TURN_TTL_SECONDS;
  const username = `${expiry}:${String(identity || 'ugamarket').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)}`;
  const credential = crypto.createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
  return [{ urls: split(env.TURN_URLS), username, credential }];
}

function turnMode() {
  if (env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN) return 'CLOUDFLARE';
  if (split(env.TURN_URLS).length && env.TURN_SECRET) return 'COTURN';
  if (split(env.TURN_URLS).length && env.TURN_USERNAME) return 'STATIC';
  return 'NONE';
}

/** ICE servers for one participant. Never throws: falls back to STUN-only. */
async function getIceServers(identity) {
  const servers = [];
  const stun = split(env.STUN_URLS);
  if (stun.length) servers.push({ urls: stun });
  const mode = turnMode();
  try {
    if (mode === 'CLOUDFLARE') servers.push(...(await cloudflareServers()));
    else if (mode === 'COTURN') servers.push(...coturnServers(identity));
    else if (mode === 'STATIC') servers.push({ urls: split(env.TURN_URLS), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
  } catch (error) {
    logger.warn(`[calls] TURN credentials unavailable (${mode}): ${error.message}. Calls fall back to direct connections only.`);
  }
  return servers;
}

module.exports = { getIceServers, turnMode, _resetCacheForTests: () => (cloudflareCache = null) };
