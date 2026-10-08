import apiClient, { ApiError, resolveImageUrl, setAuthToken, getAuthToken, clearAuthToken } from './client';

describe('api client (UgaMarket — home to home)', () => {
  beforeEach(() => {
    localStorage.clear();
    clearAuthToken();
    jest.restoreAllMocks();
  });

  test('exports get/post/patch/put/delete helpers', () => {
    expect(typeof apiClient.get).toBe('function');
    expect(typeof apiClient.post).toBe('function');
    expect(typeof apiClient.patch).toBe('function');
    expect(typeof apiClient.put).toBe('function');
    expect(typeof apiClient.delete).toBe('function');
  });

  test('normalizes backend errors into ApiError with status and message', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: false, message: 'Insufficient stock for matooke' }),
    });

    await expect(apiClient.post('/cart/items', { productId: 1, quantity: 5 })).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      message: 'Insufficient stock for matooke',
    });
  });

  test('network failure becomes ApiError with status 0', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(apiClient.get('/products')).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
    });
  });

  test('a field-level validation error replaces the generic "Validation failed"', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: false, message: 'Validation failed', errors: [{ field: 'phone', message: 'Invalid Uganda phone number format' }] }),
    });
    await expect(apiClient.post('/auth/register', {})).rejects.toMatchObject({
      status: 400,
      code: 'HTTP',
      message: 'Invalid Uganda phone number format',
    });
  });

  test('an HTML page instead of JSON is BAD_RESPONSE, and the page is never shown', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      headers: { get: () => 'text/html' },
      text: async () => '<html><body>Bad Gateway</body></html>',
    });
    const err = await apiClient.get('/products').catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: 'BAD_RESPONSE' });
    expect(err.message).not.toMatch(/<html/);
  });

  test('a 200 HTML page (wrong API address) is reported as a configuration problem', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      text: async () => '<!doctype html><div id="root"></div>',
    });
    await expect(apiClient.get('/products')).rejects.toMatchObject({ code: 'BAD_RESPONSE', status: 200 });
  });

  test('offline vs unreachable are told apart', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const online = jest.spyOn(window.navigator, 'onLine', 'get');
    online.mockReturnValue(false);
    await expect(apiClient.get('/products')).rejects.toMatchObject({ code: 'OFFLINE', status: 0 });
    online.mockReturnValue(true);
    await expect(apiClient.get('/products')).rejects.toMatchObject({ code: 'UNREACHABLE', status: 0 });
  });

  test('a request that never answers times out with code TIMEOUT', async () => {
    global.fetch = jest.fn(
      (url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })
    );
    await expect(apiClient.get('/products', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'TIMEOUT', status: 0 });
  });

  test("a caller's own abort passes through as AbortError (not reported as an error)", async () => {
    global.fetch = jest.fn(
      (url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })
    );
    const controller = new AbortController();
    const pending = apiClient.get('/products', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('401 responses dispatch the unauthorized event for session expiry handling', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: false, message: 'Token expired' }),
    });

    const listener = jest.fn();
    window.addEventListener('ugamarket:unauthorized', listener);
    try {
      await expect(apiClient.get('/cart')).rejects.toBeInstanceOf(ApiError);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('ugamarket:unauthorized', listener);
    }
  });

  test('resolveImageUrl passes through absolute URLs and resolves /images/ paths', () => {
    expect(resolveImageUrl('https://example.com/pic.jpg')).toBe('https://example.com/pic.jpg');
    expect(resolveImageUrl('/images/uploads/matooke.jpg')).toMatch(/\/images\/uploads\/matooke\.jpg$/);
    expect(resolveImageUrl(null)).toBeNull();
    expect(resolveImageUrl('javascript:alert(1)')).toBeNull();
  });

  test('auth token helpers persist and clear the session token', () => {
    setAuthToken('test-token-123');
    expect(getAuthToken()).toBe('test-token-123');
    expect(localStorage.getItem('ugamarket_token')).toBe('test-token-123');

    clearAuthToken();
    expect(getAuthToken()).toBeNull();
    expect(localStorage.getItem('ugamarket_token')).toBeNull();
  });
});
