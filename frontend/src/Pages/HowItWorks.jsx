import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ShieldCheck, ShoppingBasket, ShoppingCart, Smartphone, Wrench } from 'lucide-react';
import { useLanguage } from '../Context/LanguageContext';
import useStoreInfo from '../utils/useStoreInfo';
import './HowItWorks.css';

const HowItWorks = () => {
  const { t } = useLanguage();

  const steps = [
    { n: 1, Icon: ShoppingBasket, title: t('howStep1Title'), text: t('howLongStep1') },
    { n: 2, Icon: Smartphone, title: t('howStep2Title'), text: t('howLongStep2') },
    { n: 3, Icon: ShieldCheck, title: t('howStep3Title'), text: t('howLongStep3') }
  ];
  // FAQs are written by staff in the admin console and translated automatically.
  const { faqs, loading: faqsLoading } = useStoreInfo();

  return (
    <div className="hiw container">
      <header className="hiw__head">
        <span className="section-kicker">{t('howKicker')}</span>
        <h1 className="page-title">{t('howItWorks')}</h1>
        <p className="section-desc">{t('howSubtitle')}</p>
      </header>

      <ol className="hiw__steps">
        {steps.map(({ n, Icon, title, text }) => (
          <li key={n} className="hiw__step panel">
            <span className="hiw__badge">
              <Icon size={24} strokeWidth={1.6} aria-hidden="true" />
              <b>{n}</b>
            </span>
            <div>
              <h2>{title}</h2>
              <p>{text}</p>
            </div>
          </li>
        ))}
      </ol>

      {(faqsLoading || faqs.length > 0) && (
        <section className="hiw__faq" aria-labelledby="faq-title" aria-busy={faqsLoading}>
          <h2 id="faq-title" className="section-title">
            {t('howFaqTitle')}
          </h2>
          <div className="hiw__faq-list">
            {faqsLoading
              ? [1, 2, 3].map((n) => <div key={n} className="hiw__qa hiw__qa--skeleton panel" aria-hidden="true" />)
              : faqs.map(({ id, question, answer }) => (
                  <details key={id} className="hiw__qa panel">
                    <summary>
                      {question}
                      <ChevronDown size={18} aria-hidden="true" />
                    </summary>
                    <p>{answer}</p>
                  </details>
                ))}
          </div>
        </section>
      )}

      <section className="cta hiw__cta">
        <div>
          <h2>{t('finalCtaTitle')}</h2>
          <p>{t('finalCtaDesc')}</p>
        </div>
        <div className="cta__actions">
          <Link to="/catalog" className="btn btn-lg cta__primary">
            <ShoppingCart size={18} aria-hidden="true" /> {t('ctaBrowse')}
          </Link>
          <Link to="/services" className="btn btn-lg btn-outline-light">
            <Wrench size={18} aria-hidden="true" /> {t('bookHomeService')}
          </Link>
        </div>
      </section>
    </div>
  );
};

export default HowItWorks;
