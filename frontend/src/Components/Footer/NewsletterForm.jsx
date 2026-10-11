import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Mail } from 'lucide-react';
import apiClient from '../../api/client';
import { useLanguage } from '../../Context/LanguageContext';
import { friendlyError } from '../../utils/errors';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Footer newsletter sign-up (double opt-in): POST /api/newsletter/subscribe.
 * The consent box is unticked by default and required.
 */
const NewsletterForm = () => {
  const { t, currentLang } = useLanguage();
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState('idle'); // idle|sending|done
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const value = email.trim();
    if (!EMAIL_RE.test(value)) return setError(t('newsletterBadEmail'));
    if (!consent) return setError(t('newsletterNeedConsent'));
    setStatus('sending');
    try {
      await apiClient.post('/newsletter/subscribe', { email: value, consent: true, language: currentLang });
      setStatus('done');
    } catch (err) {
      setStatus('idle');
      setError(friendlyError(err, t, 'errGeneric'));
    }
  };

  if (status === 'done') {
    return (
      <div className="um-news um-news--done" role="status">
        <CheckCircle2 size={22} aria-hidden="true" />
        <div>
          <strong>{t('newsletterCheckInbox')}</strong>
          <p>{t('newsletterCheckInboxDesc', { email: email.trim() })}</p>
        </div>
      </div>
    );
  }

  return (
    <form className="um-news" onSubmit={submit} noValidate>
      <div className="um-news__text">
        <h4>
          <Mail size={18} aria-hidden="true" /> {t('newsletterTitle')}
        </h4>
        <p>{t('newsletterDesc')}</p>
      </div>
      <div className="um-news__form">
        <div className="um-news__row">
          <label htmlFor="um-news-email" className="um-visually-hidden">
            {t('emailLabel')}
          </label>
          <input
            id="um-news-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            className="form-input"
            placeholder={t('emailPlaceholder')}
            value={email}
            onChange={(e) => setEmail(e.target.value.slice(0, 255))}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'um-news-err' : undefined}
          />
          <button type="submit" className="btn btn-primary" disabled={status === 'sending'}>
            {status === 'sending' ? t('processing2') : t('newsletterSubscribe')}
          </button>
        </div>
        <label className="um-news__consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>
            {t('newsletterConsent')} <Link to="/privacy">{t('privacyPolicy')}</Link>
          </span>
        </label>
        {error && (
          <span className="um-news__error" id="um-news-err" role="alert">
            {error}
          </span>
        )}
      </div>
    </form>
  );
};

export default NewsletterForm;
