/**
 * Cookie & storage consent (Uganda Data Protection and Privacy Act, 2019).
 *
 * Categories:
 *   necessary    always on: sign-in session, shopping cart, security and this
 *                consent choice itself. The shop cannot work without them.
 *   preferences  remember theme, language and sound settings between visits.
 *                Without consent they still work, but only for this tab
 *                session (sessionStorage) and are forgotten afterwards.
 *   analytics    reserved: UgaMarket loads no analytics today. Any future
 *                analytics script must check hasConsent('analytics') first.
 *   marketing    reserved: no advertising/tracking cookies are used today.
 *
 * The choice is stored in a first-party cookie `um_consent` (180 days,
 * SameSite=Lax, Secure on https) so it is honoured on every page.
 */

export const CONSENT_COOKIE = 'um_consent';
export const CONSENT_VERSION = 1;
const MAX_AGE_DAYS = 180;
export const CONSENT_EVENT = 'ugamarket:consent';
export const OPEN_SETTINGS_EVENT = 'ugamarket:open-cookie-settings';

/** Storage keys that hold remembered preferences (moved on consent change). */
export const PREFERENCE_KEYS = ['ugamarket_theme', 'ugamarket_lang', 'ugamarket_sound'];

const DEFAULT = { v: CONSENT_VERSION, necessary: true, preferences: false, analytics: false, marketing: false, ts: null };

function readCookie(name) {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find((row) => row.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

/** The stored choice, or null when the visitor has not decided yet. */
export function getConsent() {
  try {
    const raw = readCookie(CONSENT_COOKIE);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== CONSENT_VERSION) return null;
    return { ...DEFAULT, ...parsed, necessary: true };
  } catch {
    return null;
  }
}

export function hasConsent(category) {
  if (category === 'necessary') return true;
  const consent = getConsent();
  return Boolean(consent && consent[category]);
}

function safeStorage(kind) {
  try {
    const store = window[kind];
    const probe = '__um_probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

/** Move remembered preferences to match the current choice. */
function migratePreferences(allowed) {
  const local = safeStorage('localStorage');
  const session = safeStorage('sessionStorage');
  if (!local || !session) return;
  for (const key of PREFERENCE_KEYS) {
    if (allowed) {
      const value = session.getItem(key);
      if (value !== null) {
        local.setItem(key, value);
        session.removeItem(key);
      }
    } else {
      const value = local.getItem(key);
      if (value !== null) {
        session.setItem(key, value);
        local.removeItem(key);
      }
    }
  }
}

export function saveConsent(choice) {
  const consent = {
    ...DEFAULT,
    preferences: Boolean(choice.preferences),
    analytics: Boolean(choice.analytics),
    marketing: Boolean(choice.marketing),
    ts: new Date().toISOString(),
  };
  const secure = typeof window !== 'undefined' && window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${CONSENT_COOKIE}=${encodeURIComponent(JSON.stringify(consent))}; Max-Age=${MAX_AGE_DAYS * 86400}; Path=/; SameSite=Lax${secure}`;
  migratePreferences(consent.preferences);
  try {
    window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: consent }));
  } catch {
    /* old browsers */
  }
  return consent;
}

export function openCookieSettings() {
  window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT));
}

/**
 * Preference storage that respects consent: localStorage (remembered) when
 * preferences are allowed, otherwise sessionStorage (this visit only).
 */
export const prefStorage = {
  get(key) {
    const local = safeStorage('localStorage');
    const session = safeStorage('sessionStorage');
    const fromSession = session ? session.getItem(key) : null;
    if (fromSession !== null) return fromSession;
    return local ? local.getItem(key) : null;
  },
  set(key, value) {
    const allowed = hasConsent('preferences');
    const local = safeStorage('localStorage');
    const session = safeStorage('sessionStorage');
    if (allowed && local) {
      local.setItem(key, value);
      session?.removeItem(key);
    } else if (session) {
      session.setItem(key, value);
      local?.removeItem(key);
    }
  },
};
