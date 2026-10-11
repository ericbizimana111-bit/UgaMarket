import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Eye, EyeOff, KeyRound } from 'lucide-react';
import apiClient from '../api/client';
import { useAuth } from '../Context/AuthContext';
import { useLanguage } from '../Context/LanguageContext';
import { useToast } from '../Components/Toast/Toast';
import CodeStep from '../Components/Otp/CodeStep';
import { friendlyError } from '../utils/errors';
import { LIMITS, normalizeUgandaPhone, passwordStrength, sanitizePassword, validateNewPassword } from '../utils/inputGuards';
import './LoginSignup.css';

/**
 * Password recovery:
 *   1. phone number or (verified) email -> POST /auth/password/forgot
 *      (always the same answer, whether or not an account exists)
 *   2. code + new password -> POST /auth/password/reset
 *      -> signed in; every other device is signed out.
 */
const ForgotPassword = () => {
  const { t } = useLanguage();
  const { setSession } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [identifier, setIdentifier] = useState(params.get('phone') || '');
  const [step, setStep] = useState(null); // { channel, sentTo, resendIn }
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [error, setError] = useState('');
  const [codeError, setCodeError] = useState('');
  const [busy, setBusy] = useState(false);

  const normalizedIdentifier = () => {
    const value = identifier.trim();
    return value.includes('@') ? value.toLowerCase() : normalizeUgandaPhone(value);
  };

  const request = async () => {
    const res = await apiClient.post('/auth/password/forgot', { identifier: normalizedIdentifier() });
    if (res?.data?.devCode) showToast(`${t('otpDevCode')}: ${res.data.devCode}`, { type: 'info', duration: 15000 });
    return { channel: res?.data?.channel || 'SMS', sentTo: res?.data?.sentTo || identifier.trim(), resendIn: res?.data?.resendInSeconds || 60 };
  };

  const start = async (e) => {
    e.preventDefault();
    setError('');
    if (identifier.trim().length < 5) return setError(t('resetEnterIdentifier'));
    setBusy(true);
    try {
      setStep(await request());
    } catch (err) {
      setError(err?.status === 429 ? err.message : friendlyError(err, t, 'errGeneric'));
    } finally {
      setBusy(false);
    }
  };

  const reset = async (code) => {
    setCodeError('');
    const problem = validateNewPassword(password);
    if (problem) {
      setPasswordError(t(problem));
      document.getElementById('reset-password')?.focus();
      return;
    }
    setPasswordError('');
    setBusy(true);
    try {
      const res = await apiClient.post('/auth/password/reset', { identifier: normalizedIdentifier(), code, password });
      setSession(res?.data?.token, res?.data?.user);
      showToast(t('resetDone'), { type: 'success', duration: 6000 });
      navigate('/account/orders', { replace: true });
    } catch (err) {
      setCodeError(err?.message || t('otpWrongCode'));
    } finally {
      setBusy(false);
    }
  };

  const strength = passwordStrength(password);

  return (
    <div className="container" style={{ padding: 'clamp(20px, 4vw, 48px) var(--gutter)' }}>
      <div className="auth__card panel" style={{ margin: '0 auto', maxWidth: 480, padding: 'clamp(20px, 4vw, 32px)' }}>
        <Link to="/login" className="otp__link" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ArrowLeft size={16} aria-hidden="true" /> {t('resetBackToLogin')}
        </Link>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0 6px' }}>
          <KeyRound size={26} aria-hidden="true" /> {t('resetTitle')}
        </h1>
        <p className="auth__lead">{step ? t('resetStep2Lead') : t('resetLead')}</p>

        {error && (
          <div className="alert alert-error" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {!step ? (
          <form onSubmit={start} noValidate>
            <div className="form-group">
              <label className="form-label" htmlFor="reset-identifier">
                {t('resetIdentifierLabel')}
              </label>
              <input
                id="reset-identifier"
                className="form-input"
                type="text"
                inputMode="email"
                autoComplete="username"
                placeholder={t('resetIdentifierPlaceholder')}
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value.slice(0, 255))}
                autoFocus
              />
              <span className="input-hint">{t('resetIdentifierHint')}</span>
            </div>
            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
              {busy ? t('processing2') : t('resetSendCode')}
            </button>
          </form>
        ) : (
          <CodeStep
            channel={step.channel}
            sentTo={step.sentTo}
            resendIn={step.resendIn}
            autoSubmit={false}
            submitting={busy}
            error={codeError}
            onSubmit={reset}
            onResend={async () => {
              try {
                const next = await request();
                setStep(next);
                return next.resendIn;
              } catch (err) {
                setCodeError(err?.message || t('errGeneric'));
                throw err;
              }
            }}
            onBack={() => {
              setStep(null);
              setCodeError('');
            }}
            submitLabel={t('resetSave')}
          >
            <div className="form-group" style={{ marginTop: 12 }}>
              <label className="form-label" htmlFor="reset-password">
                {t('resetNewPassword')}
              </label>
              <div className="pw">
                <input
                  id="reset-password"
                  className="form-input"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(sanitizePassword(e.target.value, LIMITS.passwordSignup))}
                  maxLength={LIMITS.passwordSignup}
                  aria-invalid={Boolean(passwordError)}
                  aria-describedby={passwordError ? 'reset-password-err' : 'reset-password-hint'}
                />
                <button
                  type="button"
                  className="pw__toggle"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? t('hidePassword') : t('showPassword')}
                  aria-pressed={showPassword}
                >
                  {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                </button>
              </div>
              {passwordError ? (
                <span className="field-error" id="reset-password-err" role="alert">
                  {passwordError}
                </span>
              ) : (
                <span className="input-hint" id="reset-password-hint">
                  {t('passwordRules')}
                  {password && ` · ${[t('strengthWeak'), t('strengthWeak'), t('strengthFair'), t('strengthGood'), t('strengthStrong')][strength]}`}
                </span>
              )}
            </div>
          </CodeStep>
        )}
      </div>
    </div>
  );
};

export default ForgotPassword;
