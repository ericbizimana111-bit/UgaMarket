import React, { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, MailX, XCircle } from 'lucide-react';
import apiClient from '../api/client';
import { useLanguage } from '../Context/LanguageContext';

/**
 * Landing page for newsletter email links:
 *   /newsletter/confirm?token=...       confirms the subscription
 *   /newsletter/unsubscribe?token=...   asks once, then unsubscribes
 * The API calls are POSTs made from this page, so link scanners and email
 * previews cannot confirm or unsubscribe anyone by merely opening the link.
 */
const NewsletterAction = ({ action }) => {
  const { t } = useLanguage();
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [state, setState] = useState(action === 'confirm' ? 'working' : 'ask'); // ask|working|done|error
  const [message, setMessage] = useState('');
  const started = useRef(false);

  const run = async () => {
    setState('working');
    try {
      const res = await apiClient.post(`/newsletter/${action}`, { token });
      setMessage(res?.message || '');
      setState('done');
    } catch (err) {
      setMessage(err?.message || t('errGeneric'));
      setState('error');
    }
  };

  useEffect(() => {
    if (action === 'confirm' && !started.current) {
      started.current = true;
      run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action]);

  const Icon = state === 'error' ? XCircle : state === 'ask' ? MailX : CheckCircle2;

  return (
    <div className="container" style={{ padding: 'clamp(24px, 6vw, 64px) var(--gutter)' }}>
      <div className="panel state-block" style={{ maxWidth: 520, margin: '0 auto' }}>
        <span className="state-block__icon">
          <Icon size={38} strokeWidth={1.5} aria-hidden="true" />
        </span>
        <h1 style={{ fontSize: '1.4rem' }}>{action === 'confirm' ? t('newsletterConfirmTitle') : t('newsletterUnsubTitle')}</h1>
        {state === 'working' && (
          <div className="um-spinner" role="status" aria-label={t('loading')} style={{ margin: '12px auto' }} />
        )}
        {state === 'ask' && (
          <>
            <p>{t('newsletterUnsubAsk')}</p>
            <button type="button" className="btn btn-primary" onClick={run} disabled={!token}>
              {t('newsletterUnsubButton')}
            </button>
          </>
        )}
        {(state === 'done' || state === 'error') && <p role={state === 'error' ? 'alert' : 'status'}>{message}</p>}
        <Link to="/" className="btn btn-secondary" style={{ marginTop: 12 }}>
          {t('continueShopping')}
        </Link>
      </div>
    </div>
  );
};

export default NewsletterAction;
