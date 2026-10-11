import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Cookie, X } from 'lucide-react';
import { useLanguage } from '../../Context/LanguageContext';
import { getConsent, OPEN_SETTINGS_EVENT, saveConsent } from '../../utils/consent';
import './CookieConsent.css';

const OPTIONAL = ['preferences', 'analytics', 'marketing'];

/**
 * Cookie banner (first visit) and cookie settings dialog (footer link
 * "Cookie settings"). Non-essential categories are OFF until the visitor
 * turns them on; "Reject non-essential" is as easy as "Accept all".
 */
const CookieConsent = () => {
  const { t } = useLanguage();
  const [decided, setDecided] = useState(() => getConsent() !== null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [choice, setChoice] = useState(() => {
    const c = getConsent();
    return { preferences: Boolean(c?.preferences), analytics: Boolean(c?.analytics), marketing: Boolean(c?.marketing) };
  });
  const dialogRef = useRef(null);

  useEffect(() => {
    const open = () => {
      const c = getConsent();
      setChoice({ preferences: Boolean(c?.preferences), analytics: Boolean(c?.analytics), marketing: Boolean(c?.marketing) });
      setSettingsOpen(true);
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, open);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, open);
  }, []);

  useEffect(() => {
    if (!settingsOpen) return undefined;
    dialogRef.current?.focus();
    const onKey = (e) => e.key === 'Escape' && setSettingsOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [settingsOpen]);

  const save = (value) => {
    saveConsent(value);
    setDecided(true);
    setSettingsOpen(false);
  };

  const acceptAll = () => save({ preferences: true, analytics: true, marketing: true });
  const rejectAll = () => save({ preferences: false, analytics: false, marketing: false });

  return (
    <>
      {!decided && !settingsOpen && (
        <section className="cc-banner" aria-label={t('cookieBannerLabel')}>
          <div className="cc-banner__text">
            <Cookie size={22} aria-hidden="true" className="cc-banner__icon" />
            <p>
              {t('cookieBannerText')}{' '}
              <Link to="/cookies">{t('cookiePolicy')}</Link>
            </p>
          </div>
          <div className="cc-banner__actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSettingsOpen(true)}>
              {t('cookieCustomize')}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={rejectAll}>
              {t('cookieRejectAll')}
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={acceptAll}>
              {t('cookieAcceptAll')}
            </button>
          </div>
        </section>
      )}

      {settingsOpen && (
        <div className="cc-modal" role="presentation" onClick={(e) => e.target === e.currentTarget && setSettingsOpen(false)}>
          <div className="cc-dialog" role="dialog" aria-modal="true" aria-labelledby="cc-title" tabIndex={-1} ref={dialogRef}>
            <div className="cc-dialog__head">
              <h2 id="cc-title">{t('cookieSettingsTitle')}</h2>
              <button type="button" className="um-icon-btn" onClick={() => setSettingsOpen(false)} aria-label={t('close')}>
                <X size={20} aria-hidden="true" />
              </button>
            </div>
            <p className="cc-dialog__lead">{t('cookieSettingsLead')}</p>

            <ul className="cc-list">
              <li className="cc-item">
                <div>
                  <strong>{t('cookieCat_necessary')}</strong>
                  <p>{t('cookieCat_necessary_desc')}</p>
                </div>
                <span className="cc-always">{t('cookieAlwaysOn')}</span>
              </li>
              {OPTIONAL.map((cat) => (
                <li className="cc-item" key={cat}>
                  <div>
                    <strong id={`cc-${cat}`}>{t(`cookieCat_${cat}`)}</strong>
                    <p>{t(`cookieCat_${cat}_desc`)}</p>
                  </div>
                  <label className="cc-switch">
                    <input
                      type="checkbox"
                      checked={choice[cat]}
                      onChange={(e) => setChoice((prev) => ({ ...prev, [cat]: e.target.checked }))}
                      aria-labelledby={`cc-${cat}`}
                    />
                    <span aria-hidden="true" />
                  </label>
                </li>
              ))}
            </ul>

            <div className="cc-dialog__actions">
              <button type="button" className="btn btn-secondary" onClick={rejectAll}>
                {t('cookieRejectAll')}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => save(choice)}>
                {t('cookieSaveChoices')}
              </button>
              <button type="button" className="btn btn-primary" onClick={acceptAll}>
                {t('cookieAcceptAll')}
              </button>
            </div>
            <p className="cc-dialog__foot">
              <Link to="/cookies" onClick={() => setSettingsOpen(false)}>
                {t('cookiePolicy')}
              </Link>{' '}
              ·{' '}
              <Link to="/privacy" onClick={() => setSettingsOpen(false)}>
                {t('privacyPolicy')}
              </Link>
            </p>
          </div>
        </div>
      )}
    </>
  );
};

export default CookieConsent;
