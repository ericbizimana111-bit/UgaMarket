import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../Context/LanguageContext';
import { openCookieSettings } from '../../utils/consent';
import { LEGAL_DOCS } from './legalContent';
import './Legal.css';

const RELATED = [
  { to: '/terms', key: 'termsTitle' },
  { to: '/privacy', key: 'privacyPolicy' },
  { to: '/security', key: 'securityInfo' },
  { to: '/cookies', key: 'cookiePolicy' },
  { to: '/commitment-rules', key: 'commitmentRules' },
  { to: '/help', key: 'helpCenter' }
];

const Body = ({ items }) =>
  items.map((item, i) =>
    typeof item === 'string' ? (
      <p key={i}>{item}</p>
    ) : (
      <ul key={i}>
        {item.list.map((li) => (
          <li key={li}>{li}</li>
        ))}
      </ul>
    )
  );

function formatLongDate(isoDate, lang) {
  try {
    return new Date(`${isoDate}T00:00:00`).toLocaleDateString(lang === 'lg' ? 'en-UG' : lang, { dateStyle: 'long' });
  } catch {
    return isoDate;
  }
}

/** Renders one policy document with an on-page table of contents. */
const LegalPage = ({ doc }) => {
  const { t, currentLang } = useLanguage();
  const content = LEGAL_DOCS[doc];
  if (!content) return null;

  return (
    <div className="legal container">
      <nav className="legal__crumbs" aria-label={t('breadcrumb')}>
        <Link to="/">{t('home')}</Link> / <span>{content.title}</span>
      </nav>
      <div className="legal__layout">
        <article className="legal__doc panel">
          <header className="legal__head">
            <h1>{content.title}</h1>
            <p className="legal__meta">
              {t('legalLastUpdated', { date: formatLongDate(content.version, currentLang) })} · {t('legalVersion', { v: content.version })}
            </p>
            <p className="legal__intro">{content.intro}</p>
            {currentLang !== 'en' && <p className="legal__note">{t('legalEnglishNote')}</p>}
          </header>
          {content.sections.map((section) => (
            <section key={section.id} id={section.id} className="legal__section">
              <h2>{section.heading}</h2>
              <Body items={section.body} />
            </section>
          ))}
          {doc === 'cookies' && (
            <button type="button" className="btn btn-primary" onClick={openCookieSettings}>
              {t('cookieSettings')}
            </button>
          )}
        </article>

        <aside className="legal__aside">
          <div className="panel legal__toc">
            <h2>{t('legalOnThisPage')}</h2>
            <ol>
              {content.sections.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`}>{s.heading.replace(/^\d+\.\s*/, '')}</a>
                </li>
              ))}
            </ol>
          </div>
          <div className="panel legal__toc">
            <h2>{t('legalRelated')}</h2>
            <ul>
              {RELATED.map((r) => (
                <li key={r.to}>
                  <Link to={r.to}>{t(r.key)}</Link>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
};

export default LegalPage;
