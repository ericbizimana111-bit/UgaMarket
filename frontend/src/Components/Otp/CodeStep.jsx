import React, { useEffect, useRef, useState } from 'react';
import { MailCheck, MessageSquareText } from 'lucide-react';
import { useLanguage } from '../../Context/LanguageContext';
import './CodeStep.css';

/**
 * "Enter the 6-digit code" step.
 *  - numeric keyboard, and phones offer the code from the SMS automatically
 *    (autocomplete="one-time-code")
 *  - submits by itself once 6 digits are entered
 *  - resend button with a visible countdown (server enforces the cooldown)
 */
const CodeStep = ({ channel = 'SMS', sentTo, resendIn = 60, autoSubmit = true, onSubmit, onResend, onBack, submitting = false, error = '', submitLabel, children }) => {
  const { t } = useLanguage();
  const [code, setCode] = useState('');
  const [left, setLeft] = useState(resendIn);
  const [resending, setResending] = useState(false);
  const inputRef = useRef(null);
  const lastAuto = useRef('');

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (left <= 0) return undefined;
    const timer = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);

  // A wrong code is cleared so the customer can type it again.
  useEffect(() => {
    if (error) {
      setCode('');
      inputRef.current?.focus();
    }
  }, [error]);

  const submit = (value) => {
    if (submitting || value.length !== 6) return;
    onSubmit(value);
  };

  const onChange = (e) => {
    const value = e.target.value.replace(/\D/g, '').slice(0, 6);
    setCode(value);
    if (autoSubmit && value.length === 6 && lastAuto.current !== value) {
      lastAuto.current = value;
      submit(value);
    }
  };

  const resend = async () => {
    if (left > 0 || resending) return;
    setResending(true);
    try {
      const next = await onResend();
      setLeft(typeof next === 'number' ? next : resendIn);
      lastAuto.current = '';
      setCode('');
    } catch {
      /* the parent shows the error */
    } finally {
      setResending(false);
    }
  };

  const Icon = channel === 'EMAIL' ? MailCheck : MessageSquareText;

  return (
    <form
      className="otp"
      onSubmit={(e) => {
        e.preventDefault();
        submit(code);
      }}
      noValidate
    >
      <div className="otp__head">
        <span className="otp__icon" aria-hidden="true">
          <Icon size={22} />
        </span>
        <p>
          {channel === 'EMAIL' ? t('otpSentEmail') : t('otpSentSms')} <strong>{sentTo}</strong>
        </p>
      </div>

      <label className="form-label" htmlFor="otp-code">
        {t('otpLabel')}
      </label>
      <input
        ref={inputRef}
        id="otp-code"
        className="form-input otp__input"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="one-time-code"
        maxLength={6}
        placeholder="••••••"
        value={code}
        onChange={onChange}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? 'otp-err' : 'otp-hint'}
        disabled={submitting}
      />
      {error ? (
        <span className="field-error" id="otp-err" role="alert">
          {error}
        </span>
      ) : (
        <span className="input-hint" id="otp-hint">
          {t('otpHint')}
        </span>
      )}

      {children}

      <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={submitting || code.length !== 6}>
        {submitting ? t('processing2') : submitLabel || t('otpVerify')}
      </button>

      <div className="otp__row">
        <button type="button" className="otp__link" onClick={resend} disabled={left > 0 || resending}>
          {left > 0 ? t('otpResendIn', { s: left }) : resending ? t('processing2') : t('otpResend')}
        </button>
        {onBack && (
          <button type="button" className="otp__link" onClick={onBack} disabled={submitting}>
            {t('otpChangeDetails')}
          </button>
        )}
      </div>
    </form>
  );
};

export default CodeStep;
