/**
 * Turn an API/network error into a message in the customer's language that
 * names the REAL cause (see ApiError codes in api/client.js):
 *   - no internet, server unreachable, timeout and unreadable responses each
 *     get their own message instead of one "check your connection";
 *   - API errors show the reason the server gave (validation, stock, payment
 *     provider…). Server errors also show the HTTP status so support can
 *     trace them. The API never puts internals in these messages.
 */
const GENERIC_SERVER_MESSAGE = /^(Request failed|Internal server error|Something went wrong)/i;

export function friendlyError(err, t, fallbackKey = 'errGeneric') {
  if (!err) return t(fallbackKey);

  switch (err.code) {
    case 'OFFLINE':
      return t('errOffline');
    case 'UNREACHABLE':
      return t('errUnreachable');
    case 'TIMEOUT':
      return t('errTimeout');
    case 'BAD_RESPONSE':
      return typeof err.status === 'number' && err.status >= 200 && err.status < 400
        ? t('errBadResponseConfig')
        : t('errBadResponse', { status: err.status || '?' });
    default:
      break;
  }

  const status = err.status;
  if (status === 0) return t('errUnreachable');
  if (status === 401) return t('errSession');
  if (status === 429) return t('errTooMany');
  if (typeof status === 'number' && status >= 500) {
    const reason = err.message && !GENERIC_SERVER_MESSAGE.test(err.message) ? err.message : t('errServer');
    return t('errServerDetail', { message: reason, status });
  }
  return err.message || t(fallbackKey);
}
