/**
 * Versions of the published Terms and Privacy Policy. They MUST match
 * backend/src/services/consent.service.js LEGAL_VERSIONS: checkout sends them
 * with the order and the server records exactly which version was accepted
 * (and refuses outdated ones). Bump both together when the documents change.
 */
export const LEGAL_VERSIONS = Object.freeze({
  terms: '2026-10-11',
  privacy: '2026-10-11'
});

/** Help line shown at checkout and in the Help Center. */
export const HELP_PHONE_DISPLAY = '02018881106';
export const HELP_PHONE_TEL = 'tel:02018881106';
