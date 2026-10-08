import { friendlyError } from './errors';
import { translate } from '../i18n';

const t = (key, params) => translate('en', key, params);

describe('friendlyError — names the real cause', () => {
  test('transport failures each get their own message', () => {
    expect(friendlyError({ status: 0, code: 'OFFLINE' }, t)).toMatch(/offline/i);
    expect(friendlyError({ status: 0, code: 'UNREACHABLE' }, t)).toMatch(/could not reach the UgaMarket server/i);
    expect(friendlyError({ status: 0, code: 'TIMEOUT' }, t)).toMatch(/too long to respond/i);
    expect(friendlyError({ status: 502, code: 'BAD_RESPONSE' }, t)).toMatch(/error 502/);
    expect(friendlyError({ status: 200, code: 'BAD_RESPONSE' }, t)).toMatch(/server address may be set up incorrectly/i);
  });

  test('server errors keep the reason the API gave, plus the status', () => {
    expect(friendlyError({ status: 502, code: 'HTTP', message: 'Payment initiation failed: provider timed out' }, t)).toBe(
      'Payment initiation failed: provider timed out (error 502)'
    );
    // The API's generic production message is replaced by the translated one
    expect(friendlyError({ status: 500, code: 'HTTP', message: 'Something went wrong on our side. Please try again shortly.' }, t)).toBe(
      `${t('errServer')} (error 500)`
    );
  });

  test('client errors show the specific API message', () => {
    expect(friendlyError({ status: 409, code: 'HTTP', message: 'Only 2 left in stock' }, t)).toBe('Only 2 left in stock');
    expect(friendlyError({ status: 401, code: 'HTTP', message: 'x' }, t)).toBe(t('errSession'));
    expect(friendlyError({ status: 429, code: 'HTTP', message: 'x' }, t)).toBe(t('errTooMany'));
  });

  test('falls back to the given key only when nothing better is known', () => {
    expect(friendlyError(null, t, 'productsLoadError')).toBe(t('productsLoadError'));
    expect(friendlyError({ status: 404, code: 'HTTP' }, t, 'productsLoadError')).toBe(t('productsLoadError'));
  });
});
