/**
 * Centralized API Client for UgaMarket — home to home.
 *
 * Single place for: base URL, auth token header, JSON handling,
 * error normalization and 401 session-expiry signalling.
 * Components must never call fetch() directly.
 */

// API base URL: set REACT_APP_API_URL at build time for standalone API
// origins (PUBLIC configuration only — never secrets). Unset builds fall back
// to same-origin '/api', which works behind the production reverse proxy and
// in local development via the CRA dev proxy.
export const API_BASE = process.env.REACT_APP_API_URL || '/api';

const TOKEN_STORAGE_KEY = 'ugamarket_token';

/** Backend absolute origin, used to resolve relative /images/... URLs. */
export const API_ORIGIN = (() => {
  try {
    return new URL(API_BASE).origin;
  } catch {
    return API_BASE.replace(/\/api\/?$/, '');
  }
})();

/**
 * `code` says WHY a request failed, so the UI can tell the customer the real
 * cause instead of guessing:
 *   OFFLINE       the device has no internet connection
 *   UNREACHABLE   online, but the UgaMarket server did not answer (down,
 *                 restarting, or blocked)
 *   TIMEOUT       the server accepted the connection but did not reply in time
 *   BAD_RESPONSE  the server replied with something that is not API JSON
 *                 (e.g. an HTML error page, or a misconfigured API address)
 *   HTTP          the API answered with an error status (see `status`)
 */
export class ApiError extends Error {
  constructor(message, status, data = null, code = 'HTTP') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.code = code;
  }
}

// Long enough for a sleeping free-tier API host to wake up (~30-50 s), short
// enough that a dead connection does not leave a spinner forever.
const DEFAULT_TIMEOUT_MS = 60000;

/** Most specific message the API gave: a field-level validation error beats "Validation failed". */
function apiMessage(data, status) {
  const fieldError = Array.isArray(data?.errors) ? data.errors.find((e) => e && e.message) : null;
  if (fieldError && (!data.message || data.message === 'Validation failed')) return fieldError.message;
  return data?.message || fieldError?.message || `Request failed (HTTP ${status})`;
}

/** In-memory token mirror so consumers can set/clear without touching localStorage directly. */
let currentToken = null;
try {
  currentToken = localStorage.getItem(TOKEN_STORAGE_KEY);
} catch {
  /* storage unavailable (tests / private mode) */
}

export function setAuthToken(token) {
  currentToken = token || null;
  try {
    if (currentToken) {
      localStorage.setItem(TOKEN_STORAGE_KEY, currentToken);
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    /* non-fatal */
  }
}

export function clearAuthToken() {
  setAuthToken(null);
}

export function getAuthToken() {
  return currentToken;
}

/**
 * Resolve a product/category image URL to a loadable absolute URL.
 * The backend serves uploaded images from /images/... on its own origin;
 * absolute http(s) URLs pass through unchanged.
 */
export function resolveImageUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/images/')) return `${API_ORIGIN}${trimmed}`;
  return null;
}

export async function request(endpoint, options = {}) {
  const url = endpoint.startsWith('http')
    ? endpoint
    : `${API_BASE}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

  const token = currentToken;

  const headers = {
    'Accept': 'application/json',
    ...(options.body && typeof options.body === 'object' && !(options.body instanceof FormData)
      ? { 'Content-Type': 'application/json' }
      : {}),
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...options.headers,
  };

  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...fetchOptions } = options;

  // One controller for both the timeout and a caller's own abort signal.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', forwardAbort, { once: true });
  }

  const config = {
    ...fetchOptions,
    headers,
    signal: controller.signal,
    body:
      fetchOptions.body && typeof fetchOptions.body === 'object' && !(fetchOptions.body instanceof FormData)
        ? JSON.stringify(fetchOptions.body)
        : fetchOptions.body,
  };

  try {
    const response = await fetch(url, config);

    let data = null;
    const contentType = (response.headers && response.headers.get('content-type')) || '';
    if (contentType.includes('application/json')) {
      try {
        data = await response.json();
      } catch {
        throw new ApiError(
          `The server sent an unreadable response (HTTP ${response.status}).`,
          response.status,
          null,
          'BAD_RESPONSE'
        );
      }
    } else {
      const text = typeof response.text === 'function' ? await response.text() : '';
      if (text.trim()) {
        // An HTML page instead of API JSON: a proxy/host error page, or the
        // shop calling the wrong address. Never show the page itself.
        throw new ApiError(
          response.ok
            ? 'The shop received a web page instead of data from the server. The API address may be misconfigured.'
            : `The server is having a problem right now (HTTP ${response.status}). Please try again shortly.`,
          response.status,
          null,
          'BAD_RESPONSE'
        );
      }
      data = {};
    }

    if (!response.ok) {
      if (response.status === 401) {
        // Session expired / invalid: notify listeners so auth state can be cleared.
        window.dispatchEvent(new CustomEvent('ugamarket:unauthorized'));
      }
      throw new ApiError(apiMessage(data, response.status), response.status, data, 'HTTP');
    }

    return data;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    // The caller cancelled (e.g. the page changed): pass the AbortError through.
    if (callerSignal && callerSignal.aborted && !timedOut) {
      throw error;
    }
    if (timedOut) {
      throw new ApiError('The server took too long to respond. Please try again.', 0, null, 'TIMEOUT');
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new ApiError('You are offline. Check your internet connection and try again.', 0, null, 'OFFLINE');
    }
    throw new ApiError(
      'Could not reach the UgaMarket server. It may be restarting or temporarily unavailable. Please try again in a moment.',
      0,
      null,
      'UNREACHABLE'
    );
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', forwardAbort);
  }
}

export const api = {
  get: (endpoint, options) => request(endpoint, { ...options, method: 'GET' }),
  post: (endpoint, body, options) => request(endpoint, { ...options, method: 'POST', body }),
  patch: (endpoint, body, options) => request(endpoint, { ...options, method: 'PATCH', body }),
  put: (endpoint, body, options) => request(endpoint, { ...options, method: 'PUT', body }),
  delete: (endpoint, options) => request(endpoint, { ...options, method: 'DELETE' }),
};

export default api;
