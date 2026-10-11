import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../Context/LanguageContext';
import useStoreInfo from '../../utils/useStoreInfo';
import { formatUGX } from '../../utils/currency';
import './Legal.css';

/**
 * Commitment (deposit) rules. The live deposit rule comes from the store
 * settings managed in the admin console, so this page never goes stale.
 */
const CommitmentRules = () => {
  const { t } = useLanguage();
  const { commitment } = useStoreInfo();

  const depositText = !commitment
    ? t('rulesDepositFallback')
    : commitment.ruleType === 'FLAT'
      ? formatUGX(commitment.flatUgx)
      : `${commitment.percentage}%`;

  return (
    <div className="legal container">
      <nav className="legal__crumbs" aria-label={t('breadcrumb')}>
        <Link to="/">{t('home')}</Link> / <span>{t('commitmentRules')}</span>
      </nav>
      <article className="legal__doc panel">
        <header className="legal__head">
          <h1>{t('commitmentRules')}</h1>
          <p className="legal__intro">{t('rulesIntro')}</p>
        </header>

        <div className="rules__grid">
          <div className="rules__stat">
            <small>{t('rulesDeposit')}</small>
            <strong>{depositText}</strong>
          </div>
          {commitment?.minimumUgx > 0 && (
            <div className="rules__stat">
              <small>{t('rulesMinimum')}</small>
              <strong>{formatUGX(commitment.minimumUgx)}</strong>
            </div>
          )}
          <div className="rules__stat">
            <small>{t('rulesBalanceWhen')}</small>
            <strong>{t('rulesBalanceValue')}</strong>
          </div>
        </div>

        {[1, 2, 3, 4, 5, 6].map((n) => (
          <section className="legal__section" key={n}>
            <h2>{t(`rulesH${n}`)}</h2>
            <p>{t(`rulesP${n}`)}</p>
          </section>
        ))}
        <p className="legal__note" style={{ marginTop: 24 }}>
          {t('rulesSeeTerms')} <Link to="/terms">{t('termsTitle')}</Link>
        </p>
      </article>
    </div>
  );
};

export default CommitmentRules;
