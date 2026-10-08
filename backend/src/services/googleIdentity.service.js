const { OAuth2Client } = require('google-auth-library');
const env = require('../config/env');
const { AppError } = require('../middleware/errorHandler');

/**
 * Google Identity verification for "Continue with Google".
 *
 * The storefront obtains a Google ID token (a signed JWT) from Google Identity
 * Services and posts it here. google-auth-library checks the signature against
 * Google's published keys, the issuer, the expiry and that the token was
 * issued for OUR client ID (audience) — a token minted for another site is
 * rejected. Nothing from the token is trusted before this check.
 */

let client = null;

function getClient() {
  if (!client) client = new OAuth2Client();
  return client;
}

/**
 * Returns { sub, email, emailVerified, name } for a valid token, or throws
 * AppError(401). Throws AppError(503) when Google sign-in is not configured.
 */
async function verifyGoogleCredential(credential) {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new AppError('Google sign-in is not available right now', 503);
  }

  let payload;
  try {
    const ticket = await getClient().verifyIdToken({ idToken: credential, audience: env.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    throw new AppError('Google sign-in failed. Please try again.', 401);
  }

  if (!payload || !payload.sub) {
    throw new AppError('Google sign-in failed. Please try again.', 401);
  }

  return {
    sub: String(payload.sub),
    email: payload.email ? String(payload.email).trim().toLowerCase() : null,
    emailVerified: payload.email_verified === true,
    name: payload.name ? String(payload.name).trim() : '',
  };
}

module.exports = { verifyGoogleCredential };
