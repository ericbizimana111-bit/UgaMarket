import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Clock, Headset, Mail, MapPin, MessageCircle, Phone, ShieldCheck, Truck, Wallet } from 'lucide-react';
import { useLanguage } from '../../Context/LanguageContext';
import { useAuth } from '../../Context/AuthContext';
import { useCall } from '../../Context/CallContext';
import useCategories from '../../utils/useCategories';
import useStoreInfo, { formatUgPhone } from '../../utils/useStoreInfo';
import LanguageSwitcher from '../LanguageSwitcher/LanguageSwitcher';
import NewsletterForm from './NewsletterForm';
import { openCookieSettings } from '../../utils/consent';
import { HELP_PHONE_DISPLAY, HELP_PHONE_TEL } from '../../utils/legal';
import './Footer.css';

const LOGO_SRC = `${process.env.PUBLIC_URL}/logo.png`;
const DESKTOP_QUERY = '(min-width: 769px)';

function useIsDesktop() {
  const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(DESKTOP_QUERY).matches;
  const [desktop, setDesktop] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = (e) => setDesktop(e.matches);
    mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange);
    return () => (mq.removeEventListener ? mq.removeEventListener('change', onChange) : mq.removeListener(onChange));
  }, []);
  return desktop;
}

/** A link column: always open on desktop, a tap-to-open section on phones. */
const Column = ({ title, desktop, children }) =>
  desktop ? (
    <nav className="um-fcol" aria-label={title}>
      <h4 className="um-fcol__title">{title}</h4>
      <ul>{children}</ul>
    </nav>
  ) : (
    <details className="um-fcol um-fcol--fold">
      <summary className="um-fcol__title">
        {title}
        <ChevronDown size={18} aria-hidden="true" />
      </summary>
      <ul>{children}</ul>
    </details>
  );

/**
 * Site footer, laid out like the big marketplaces (Alibaba.com): trust
 * strip, newsletter, grouped link columns, contact details, payment
 * methods, and a bottom bar with the logo, policies and copyright.
 */
const Footer = () => {
  const { t, getLocalizedField } = useLanguage();
  const { isAuthenticated } = useAuth();
  const { startCall } = useCall();
  const { categories } = useCategories();
  // Contact details are managed by staff in the admin console; unset ones are hidden.
  const { store } = useStoreInfo();
  const desktop = useIsDesktop();

  const trust = [
    { Icon: Truck, title: t('footerTrustDelivery'), text: t('footerTrustDeliveryDesc') },
    { Icon: Wallet, title: t('footerTrustDeposit'), text: t('footerTrustDepositDesc') },
    { Icon: ShieldCheck, title: t('footerTrustInspect'), text: t('footerTrustInspectDesc') },
    { Icon: Headset, title: t('footerTrustSupport'), text: t('footerTrustSupportDesc') }
  ];

  return (
    <footer className="um-footer">
      <section className="um-footer__trust" aria-label={t('footerWhyUs')}>
        <ul className="container um-footer__trust-list">
          {trust.map(({ Icon, title, text }) => (
            <li key={title}>
              <span className="um-footer__trust-icon" aria-hidden="true">
                <Icon size={22} />
              </span>
              <span>
                <strong>{title}</strong>
                <small>{text}</small>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <div className="container um-footer__main">
        <NewsletterForm />

        <div className="um-footer__cols">
          <Column title={t('footerColSupport')} desktop={desktop}>
            <li>
              <Link to="/help">{t('helpCenter')}</Link>
            </li>
            <li>
              <Link to="/account/messages">{t('chatWithUs')}</Link>
            </li>
            <li>
              {isAuthenticated ? (
                <button type="button" onClick={startCall}>
                  {t('callSupport')}
                </button>
              ) : (
                <a href={HELP_PHONE_TEL}>{t('helpCallPhone')}</a>
              )}
            </li>
            <li>
              <Link to="/how-it-works">{t('howItWorks')}</Link>
            </li>
            <li>
              <Link to="/services">{t('bookHomeService')}</Link>
            </li>
          </Column>

          <Column title={t('footerColPayments')} desktop={desktop}>
            <li>
              <Link to="/commitment-rules">{t('commitmentRules')}</Link>
            </li>
            <li>
              <Link to="/terms#inspection">{t('footerReturns')}</Link>
            </li>
            <li>
              <Link to="/terms#payment">{t('footerMobileMoney')}</Link>
            </li>
            <li>
              <Link to="/security">{t('securityInfo')}</Link>
            </li>
            <li>
              <Link to="/privacy">{t('privacyPolicy')}</Link>
            </li>
          </Column>

          <Column title={t('footerShop')} desktop={desktop}>
            <li>
              <Link to="/catalog">{t('shopAll')}</Link>
            </li>
            {categories.slice(0, 5).map((cat) => (
              <li key={cat.id}>
                <Link to={`/catalog?category=${encodeURIComponent(cat.slug)}`}>{getLocalizedField(cat, 'name') || cat.name}</Link>
              </li>
            ))}
            <li>
              <Link to="/services">{t('homeServices')}</Link>
            </li>
          </Column>

          <Column title={t('footerAccount')} desktop={desktop}>
            {!isAuthenticated && (
              <>
                <li>
                  <Link to="/login">{t('signIn')}</Link>
                </li>
                <li>
                  <Link to="/login?signup=true">{t('signup')}</Link>
                </li>
              </>
            )}
            <li>
              <Link to="/account/orders">{t('footerMyOrders')}</Link>
            </li>
            <li>
              <Link to="/account/messages">{t('messages')}</Link>
            </li>
            <li>
              <Link to="/account/addresses">{t('footerSavedAddresses')}</Link>
            </li>
            <li>
              <Link to="/account/security">{t('securityTitle')}</Link>
            </li>
          </Column>

          <div className="um-fcol um-fcol--contact">
            <h4 className="um-fcol__title">{t('footerColContact')}</h4>
            <address className="um-footer__contact">
              <a href={HELP_PHONE_TEL}>
                <Phone size={16} aria-hidden="true" />
                <span>
                  <small>{t('helpLine')}</small>
                  {HELP_PHONE_DISPLAY}
                </span>
              </a>
              {store?.supportPhone && (
                <a href={`tel:${store.supportPhone}`}>
                  <Phone size={16} aria-hidden="true" />
                  <span>{formatUgPhone(store.supportPhone)}</span>
                </a>
              )}
              {store?.whatsappPhone && (
                <a href={`https://wa.me/${store.whatsappPhone.replace(/\D/g, '')}`} target="_blank" rel="noopener noreferrer">
                  <MessageCircle size={16} aria-hidden="true" />
                  <span>WhatsApp {formatUgPhone(store.whatsappPhone)}</span>
                </a>
              )}
              {store?.supportEmail && (
                <a href={`mailto:${store.supportEmail}`}>
                  <Mail size={16} aria-hidden="true" />
                  <span>{store.supportEmail}</span>
                </a>
              )}
              <span>
                <MapPin size={16} aria-hidden="true" />
                <span>{store?.addressText || t('footerLocation')}</span>
              </span>
              {store?.businessHours && (
                <span>
                  <Clock size={16} aria-hidden="true" />
                  <span>{store.businessHours}</span>
                </span>
              )}
            </address>
          </div>
        </div>

        <div className="um-footer__strip">
          <div className="um-footer__pay">
            <span>{t('footerPayWith')}</span>
            <ul>
              <li className="um-paybadge um-paybadge--mtn">MTN MoMo</li>
              <li className="um-paybadge um-paybadge--airtel">Airtel Money</li>
            </ul>
          </div>
          <div className="um-footer__lang">
            <span>{t('language')}</span>
            <LanguageSwitcher />
          </div>
        </div>
      </div>

      <div className="um-footer__bottom">
        <div className="container um-footer__bottom-inner">
          <Link to="/" className="um-footer__brand" aria-label={t('brandName')}>
            <img src={LOGO_SRC} alt="" width="164" height="48" loading="lazy" />
          </Link>
          <nav className="um-footer__legal" aria-label={t('legalRelated')}>
            <Link to="/terms">{t('termsTitle')}</Link>
            <Link to="/privacy">{t('privacyPolicy')}</Link>
            <Link to="/security">{t('securityInfo')}</Link>
            <Link to="/cookies">{t('cookiePolicy')}</Link>
            <button type="button" onClick={openCookieSettings}>
              {t('cookieSettings')}
            </button>
          </nav>
          <p className="um-footer__copy">
            {t('footerRights', { year: new Date().getFullYear() })} {t('footerPricesUgx')}
          </p>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
