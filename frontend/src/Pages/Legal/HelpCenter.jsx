import React from 'react';
import { Link } from 'react-router-dom';
import { Cookie, FileText, Lock, Mail, MessageCircle, Phone, PhoneCall, ShieldCheck, Truck, Wallet } from 'lucide-react';
import { useLanguage } from '../../Context/LanguageContext';
import { useAuth } from '../../Context/AuthContext';
import { useCall } from '../../Context/CallContext';
import useStoreInfo, { formatUgPhone } from '../../utils/useStoreInfo';
import { HELP_PHONE_DISPLAY, HELP_PHONE_TEL } from '../../utils/legal';
import './Legal.css';

/**
 * Help Center: every way to reach UgaMarket in one place (phone, in-app
 * voice call, chat, WhatsApp, email), the FAQs managed in the admin console,
 * and links to the policies.
 */
const HelpCenter = () => {
  const { t } = useLanguage();
  const { isAuthenticated } = useAuth();
  const { startCall } = useCall();
  const { store, faqs } = useStoreInfo();

  return (
    <div className="legal container">
      <section className="panel help__hero">
        <h1>{t('helpCenterTitle')}</h1>
        <p>{t('helpCenterLead')}</p>

        <div className="help__contact">
          <a href={HELP_PHONE_TEL} className="help__card">
            <Phone size={22} aria-hidden="true" />
            <strong>{t('helpCallPhone')}</strong>
            <span>{HELP_PHONE_DISPLAY}</span>
          </a>
          {isAuthenticated ? (
            <button type="button" className="help__card" onClick={startCall}>
              <PhoneCall size={22} aria-hidden="true" />
              <strong>{t('callSupport')}</strong>
              <span>{t('helpCallInApp')}</span>
            </button>
          ) : (
            <Link to="/login?redirect=%2Fhelp" className="help__card">
              <PhoneCall size={22} aria-hidden="true" />
              <strong>{t('callSupport')}</strong>
              <span>{t('helpSignInToCall')}</span>
            </Link>
          )}
          <Link to="/account/messages" className="help__card">
            <MessageCircle size={22} aria-hidden="true" />
            <strong>{t('chatWithUs')}</strong>
            <span>{t('helpChatDesc')}</span>
          </Link>
          {store?.whatsappPhone && (
            <a href={`https://wa.me/${store.whatsappPhone.replace(/\D/g, '')}`} target="_blank" rel="noopener noreferrer" className="help__card">
              <MessageCircle size={22} aria-hidden="true" />
              <strong>WhatsApp</strong>
              <span>{formatUgPhone(store.whatsappPhone)}</span>
            </a>
          )}
          {store?.supportEmail && (
            <a href={`mailto:${store.supportEmail}`} className="help__card">
              <Mail size={22} aria-hidden="true" />
              <strong>{t('emailLabel')}</strong>
              <span>{store.supportEmail}</span>
            </a>
          )}
        </div>
        {store?.businessHours && <p style={{ marginTop: 14 }}>{t('helpHours', { hours: store.businessHours })}</p>}
      </section>

      {faqs.length > 0 && (
        <section className="help__section">
          <h2>{t('helpFaqTitle')}</h2>
          <div className="help__faq">
            {faqs.map((f) => (
              <details key={f.id}>
                <summary>{f.question}</summary>
                <p>{f.answer}</p>
              </details>
            ))}
          </div>
        </section>
      )}

      <section className="help__section">
        <h2>{t('helpPoliciesTitle')}</h2>
        <div className="help__links">
          <Link to="/how-it-works">
            <Truck size={18} aria-hidden="true" /> {t('howItWorks')}
          </Link>
          <Link to="/commitment-rules">
            <Wallet size={18} aria-hidden="true" /> {t('commitmentRules')}
          </Link>
          <Link to="/terms">
            <FileText size={18} aria-hidden="true" /> {t('termsTitle')}
          </Link>
          <Link to="/privacy">
            <Lock size={18} aria-hidden="true" /> {t('privacyPolicy')}
          </Link>
          <Link to="/security">
            <ShieldCheck size={18} aria-hidden="true" /> {t('securityInfo')}
          </Link>
          <Link to="/cookies">
            <Cookie size={18} aria-hidden="true" /> {t('cookiePolicy')}
          </Link>
        </div>
      </section>
    </div>
  );
};

export default HelpCenter;
