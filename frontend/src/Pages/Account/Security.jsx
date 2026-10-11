import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, BadgeCheck, Cookie, KeyRound, Mail, Megaphone, Phone, ShieldAlert } from 'lucide-react';
import apiClient from '../../api/client';
import { useAuth } from '../../Context/AuthContext';
import { useLanguage } from '../../Context/LanguageContext';
import { useToast } from '../../Components/Toast/Toast';
import CodeStep from '../../Components/Otp/CodeStep';
import { friendlyError } from '../../utils/errors';
import { openCookieSettings } from '../../utils/consent';
import { LIMITS, normalizeUgandaPhone, sanitizePassword, validateNewPassword } from '../../utils/inputGuards';
import './Security.css';

/**
 * Account security & privacy:
 *  - verify the current phone / email with a one-time code
 *  - change phone (current password + code to the new number) or email
 *    (code to the new address)
 *  - change password (signs out other devices)
 *  - marketing communications consent (recorded with history)
 *  - cookie settings
 */
const Security = () => {
  const { user, setSession } = useAuth();
  const { t, formatDateTime } = useLanguage();
  const { showToast } = useToast();

  // flow: null | { kind: 'verify'|'change', channel, value?, sentTo, resendIn }
  const [flow, setFlow] = useState(null);
  const [editing, setEditing] = useState(null); // 'SMS' | 'EMAIL' | null
  const [newValue, setNewValue] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [codeError, setCodeError] = useState('');

  const [pw, setPw] = useState({ current: '', next: '' });
  const [pwError, setPwError] = useState('');
  const [pwBusy, setPwBusy] = useState(false);

  const [consents, setConsents] = useState(null);
  const [consentBusy, setConsentBusy] = useState(false);
  // Phone (SMS) codes are switched off for now.
  const [smsCodes, setSmsCodes] = useState(false);

  useEffect(() => {
    apiClient
      .get('/auth/verification-config')
      .then((res) => setSmsCodes(res?.data?.channels?.SMS === true))
      .catch(() => {});
  }, []);

  useEffect(() => {
    apiClient
      .get('/auth/consents')
      .then((res) => setConsents(res?.data || null))
      .catch(() => {});
  }, []);

  const devToast = (res) => res?.data?.devCode && showToast(`${t('otpDevCode')}: ${res.data.devCode}`, { type: 'info', duration: 15000 });

  const startVerify = async (channel) => {
    setError('');
    setBusy(true);
    try {
      const res = await apiClient.post('/auth/verify/start', { channel });
      devToast(res);
      setFlow({ kind: 'verify', channel, sentTo: res?.data?.sentTo, resendIn: res?.data?.resendInSeconds || 60 });
    } catch (err) {
      setError(err?.message || friendlyError(err, t, 'errGeneric'));
    } finally {
      setBusy(false);
    }
  };

  const startChange = async (e) => {
    e.preventDefault();
    setError('');
    const channel = editing;
    const value = channel === 'SMS' ? normalizeUgandaPhone(newValue) : newValue.trim().toLowerCase();
    setBusy(true);
    try {
      const res = await apiClient.post('/auth/contact/change/start', {
        channel,
        value,
        ...(channel === 'SMS' ? { currentPassword } : {})
      });
      devToast(res);
      setFlow({ kind: 'change', channel, value, sentTo: res?.data?.sentTo, resendIn: res?.data?.resendInSeconds || 60 });
    } catch (err) {
      setError(err?.message || friendlyError(err, t, 'errGeneric'));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    try {
      const res =
        flow.kind === 'verify'
          ? await apiClient.post('/auth/verify/start', { channel: flow.channel })
          : await apiClient.post('/auth/contact/change/start', {
              channel: flow.channel,
              value: flow.value,
              ...(flow.channel === 'SMS' ? { currentPassword } : {})
            });
      devToast(res);
      return res?.data?.resendInSeconds || 60;
    } catch (err) {
      setCodeError(err?.message || t('errGeneric'));
      throw err;
    }
  };

  const confirm = async (code) => {
    setCodeError('');
    setBusy(true);
    try {
      const res =
        flow.kind === 'verify'
          ? await apiClient.post('/auth/verify/confirm', { channel: flow.channel, code })
          : await apiClient.post('/auth/contact/change/confirm', { channel: flow.channel, value: flow.value, code });
      setSession(res?.data?.token, res?.data?.user);
      showToast(res?.message || t('saved'), { type: 'success' });
      setFlow(null);
      setEditing(null);
      setNewValue('');
      setCurrentPassword('');
    } catch (err) {
      setCodeError(err?.message || t('otpWrongCode'));
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async (e) => {
    e.preventDefault();
    setPwError('');
    const problem = validateNewPassword(pw.next);
    if (!pw.current) return setPwError(t('securityEnterCurrent'));
    if (problem) return setPwError(t(problem));
    setPwBusy(true);
    try {
      const res = await apiClient.post('/auth/password/change', { currentPassword: pw.current, newPassword: pw.next });
      setSession(res?.data?.token, res?.data?.user);
      setPw({ current: '', next: '' });
      showToast(t('securityPasswordChanged'), { type: 'success', duration: 6000 });
    } catch (err) {
      setPwError(err?.message || friendlyError(err, t, 'errGeneric'));
    } finally {
      setPwBusy(false);
    }
  };

  const toggleMarketing = async () => {
    if (!consents) return;
    setConsentBusy(true);
    try {
      const res = await apiClient.put('/auth/consents/marketing', { granted: !consents.marketingConsent });
      setConsents(res?.data || consents);
      showToast(res?.message || t('saved'), { type: 'success' });
    } catch (err) {
      showToast(friendlyError(err, t, 'errGeneric'), { type: 'error' });
    } finally {
      setConsentBusy(false);
    }
  };

  const status = (verified) =>
    verified ? (
      <span className="badge badge-success">
        <BadgeCheck size={12} aria-hidden="true" /> {t('verified')}
      </span>
    ) : (
      <span className="badge badge-warning">{t('notVerified')}</span>
    );

  if (flow) {
    return (
      <div className="panel account-card sec">
        <h2>{flow.channel === 'EMAIL' ? t('securityConfirmEmail') : t('securityConfirmPhone')}</h2>
        <CodeStep
          channel={flow.channel}
          sentTo={flow.sentTo}
          resendIn={flow.resendIn}
          submitting={busy}
          error={codeError}
          onSubmit={confirm}
          onResend={resend}
          onBack={() => {
            setFlow(null);
            setCodeError('');
          }}
        />
      </div>
    );
  }

  return (
    <div className="sec">
      {error && (
        <div className="alert alert-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <section className="panel account-card">
        <h2>{t('securityContactTitle')}</h2>
        <p className="section-desc">{t('securityContactDesc')}</p>

        <div className="sec__row">
          <Phone size={20} aria-hidden="true" />
          <div className="sec__info">
            <strong>{t('phoneLabel')}</strong>
            <span>{user?.phone}</span>
            {smsCodes || user?.phoneVerifiedAt ? status(Boolean(user?.phoneVerifiedAt)) : null}
          </div>
          <div className="sec__actions">
            {smsCodes ? (
              <>
                {!user?.phoneVerifiedAt && (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => startVerify('SMS')} disabled={busy}>
                    {t('verifyNow')}
                  </button>
                )}
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setEditing(editing === 'SMS' ? null : 'SMS'); setNewValue(''); setError(''); }}>
                  {t('change')}
                </button>
              </>
            ) : (
              <small className="input-hint">{t('phoneVerifySoon')}</small>
            )}
          </div>
        </div>

        {editing === 'SMS' && (
          <form className="sec__form" onSubmit={startChange} noValidate>
            <div className="form-group">
              <label className="form-label" htmlFor="sec-phone">{t('securityNewPhone')}</label>
              <input id="sec-phone" className="form-input" type="tel" inputMode="tel" autoComplete="tel" placeholder={t('phonePlaceholder')} value={newValue} onChange={(e) => setNewValue(e.target.value.slice(0, LIMITS.phoneIntl))} />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="sec-current">{t('securityCurrentPassword')}</label>
              <input id="sec-current" className="form-input" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(sanitizePassword(e.target.value, LIMITS.passwordLogin))} />
              <span className="input-hint">
                {t('securityGoogleNoPassword')} <Link to="/forgot-password">{t('forgotPassword')}</Link>
              </span>
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy || newValue.trim().length < 9 || !currentPassword}>
              {busy ? t('processing2') : t('securitySendCode')}
            </button>
          </form>
        )}

        <div className="sec__row">
          <Mail size={20} aria-hidden="true" />
          <div className="sec__info">
            <strong>{t('emailLabel')}</strong>
            <span>{user?.email || t('securityNoEmail')}</span>
            {user?.email && status(Boolean(user?.emailVerifiedAt))}
          </div>
          <div className="sec__actions">
            {user?.email && !user?.emailVerifiedAt && (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => startVerify('EMAIL')} disabled={busy}>
                {t('verifyNow')}
              </button>
            )}
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setEditing(editing === 'EMAIL' ? null : 'EMAIL'); setNewValue(''); setError(''); }}>
              {user?.email ? t('change') : t('add')}
            </button>
          </div>
        </div>

        {editing === 'EMAIL' && (
          <form className="sec__form" onSubmit={startChange} noValidate>
            <div className="form-group">
              <label className="form-label" htmlFor="sec-email">{t('securityNewEmail')}</label>
              <input id="sec-email" className="form-input" type="email" inputMode="email" autoComplete="email" placeholder={t('emailPlaceholder')} value={newValue} onChange={(e) => setNewValue(e.target.value.slice(0, 255))} />
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newValue.trim())}>
              {busy ? t('processing2') : t('securitySendCode')}
            </button>
          </form>
        )}
      </section>

      <section className="panel account-card">
        <h2>
          <KeyRound size={18} aria-hidden="true" /> {t('securityPasswordTitle')}
        </h2>
        <p className="section-desc">{t('securityPasswordDesc')}</p>
        <form className="sec__form" onSubmit={changePassword} noValidate>
          <div className="form-group">
            <label className="form-label" htmlFor="sec-pw-current">{t('securityCurrentPassword')}</label>
            <input id="sec-pw-current" className="form-input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw((p) => ({ ...p, current: sanitizePassword(e.target.value, LIMITS.passwordLogin) }))} />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="sec-pw-next">{t('resetNewPassword')}</label>
            <input id="sec-pw-next" className="form-input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw((p) => ({ ...p, next: sanitizePassword(e.target.value, LIMITS.passwordSignup) }))} />
            <span className="input-hint">{t('passwordRules')}</span>
          </div>
          {pwError && (
            <span className="field-error" role="alert">
              {pwError}
            </span>
          )}
          <button type="submit" className="btn btn-primary" disabled={pwBusy}>
            {pwBusy ? t('processing2') : t('securityChangePassword')}
          </button>
        </form>
      </section>

      <section className="panel account-card">
        <h2>
          <Megaphone size={18} aria-hidden="true" /> {t('securityMarketingTitle')}
        </h2>
        <div className="sec__row sec__row--plain">
          <div className="sec__info">
            <span>{t('consentMarketing')}</span>
            {consents?.marketingConsentAt && (
              <small className="input-hint">{t('securityConsentChanged', { date: formatDateTime(consents.marketingConsentAt) })}</small>
            )}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(consents?.marketingConsent)}
            className={`sec__switch ${consents?.marketingConsent ? 'sec__switch--on' : ''}`}
            onClick={toggleMarketing}
            disabled={!consents || consentBusy}
            aria-label={t('securityMarketingTitle')}
          >
            <span aria-hidden="true" />
          </button>
        </div>
        <p className="input-hint">{t('securityMarketingHint')}</p>
      </section>

      <section className="panel account-card">
        <h2>
          <ShieldAlert size={18} aria-hidden="true" /> {t('securityPrivacyTitle')}
        </h2>
        <div className="sec__links">
          <button type="button" className="btn btn-secondary btn-sm" onClick={openCookieSettings}>
            <Cookie size={16} aria-hidden="true" /> {t('cookieSettings')}
          </button>
          <Link to="/privacy" className="btn btn-secondary btn-sm">{t('privacyPolicy')}</Link>
          <Link to="/security" className="btn btn-secondary btn-sm">{t('securityInfo')}</Link>
        </div>
      </section>
    </div>
  );
};

export default Security;
