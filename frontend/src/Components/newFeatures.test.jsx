import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '../Context/LanguageContext';
import { ThemeProvider, useTheme } from '../Context/ThemeContext';
import CookieConsent from './CookieConsent/CookieConsent';
import { Receipt } from '../Pages/Account/Messages';
import { getConsent, hasConsent } from '../utils/consent';
import { translate } from '../i18n';

const t = (key, params) => translate('en', key, params);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'um_consent=; Max-Age=0; Path=/';
});

describe('cookie consent', () => {
  const renderBanner = () =>
    render(
      <MemoryRouter>
        <LanguageProvider>
          <CookieConsent />
        </LanguageProvider>
      </MemoryRouter>
    );

  test('first visit shows the banner; rejecting keeps only essential cookies', () => {
    renderBanner();
    expect(screen.getByText(/We use essential cookies/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reject non-essential' }));
    expect(screen.queryByText(/We use essential cookies/)).not.toBeInTheDocument();
    expect(getConsent()).toMatchObject({ necessary: true, preferences: false, analytics: false, marketing: false });
  });

  test('custom choices are saved per category', () => {
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Preferences' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save my choices' }));
    expect(hasConsent('preferences')).toBe(true);
    expect(hasConsent('analytics')).toBe(false);
  });
});

describe('message receipts', () => {
  test('one tick = sent, two ticks = delivered, green ticks = read', () => {
    const { rerender } = render(<Receipt t={t} message={{ deliveredAt: null, readAt: null }} />);
    expect(screen.getByLabelText('Sent')).toBeInTheDocument();

    rerender(<Receipt t={t} message={{ deliveredAt: '2026-10-11T10:00:00Z', readAt: null }} />);
    expect(screen.getByLabelText('Delivered')).not.toHaveClass('tick--read');

    rerender(<Receipt t={t} message={{ deliveredAt: '2026-10-11T10:00:00Z', readAt: '2026-10-11T10:01:00Z' }} />);
    expect(screen.getByLabelText('Read')).toHaveClass('tick--read');
  });
});

describe('themes', () => {
  const Switcher = () => {
    const { setMode, setAccent } = useTheme();
    return (
      <>
        <button onClick={() => setMode('dark')}>dark</button>
        <button onClick={() => setAccent('blue')}>blue</button>
      </>
    );
  };

  test('light mode is the default, even when the device prefers dark', () => {
    const original = window.matchMedia;
    window.matchMedia = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
    render(
      <ThemeProvider>
        <Switcher />
      </ThemeProvider>
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    window.matchMedia = original;
  });

  test('the chosen mode and colour apply to the whole document', () => {
    render(
      <ThemeProvider>
        <Switcher />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByText('dark'));
    fireEvent.click(screen.getByText('blue'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-accent')).toBe('blue');
    // Without preference consent the choice lasts for this visit only.
    expect(JSON.parse(sessionStorage.getItem('ugamarket_theme'))).toEqual({ mode: 'dark', accent: 'blue' });
  });
});
