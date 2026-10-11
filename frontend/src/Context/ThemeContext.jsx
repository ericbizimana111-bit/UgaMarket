import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { prefStorage } from '../utils/consent';

/**
 * Storefront appearance: light / dark / follow-the-device, plus a colour
 * theme. Applied as data attributes on <html> (see styles/themes.css), so the
 * entire shop — every page, dialog and component — follows the choice.
 * public/index.html applies the saved choice before React loads (no flash).
 */

export const THEME_ACCENTS = [
  { id: 'green', swatch: '#1c5233' },
  { id: 'blue', swatch: '#1d4ed8' },
  { id: 'purple', swatch: '#6d28d9' },
  { id: 'teal', swatch: '#0f766e' },
  { id: 'orange', swatch: '#c2410c' },
  { id: 'rose', swatch: '#be123c' },
  { id: 'midnight', swatch: '#1e293b' }
];
export const THEME_MODES = ['light', 'dark', 'system'];

const STORAGE_KEY = 'ugamarket_theme';
// Light is the default; dark (or following the device) is the customer's choice.
const DEFAULTS = { mode: 'light', accent: 'green' };
const ACCENT_IDS = new Set(THEME_ACCENTS.map((a) => a.id));

// Browser UI colour (Android address bar) per resolved theme.
const BAR_COLORS = {
  light: { green: '#1c5233', blue: '#1d4ed8', purple: '#6d28d9', teal: '#0f766e', orange: '#c2410c', rose: '#be123c', midnight: '#1e293b' },
  dark: '#0b1117'
};

function readSaved() {
  try {
    const parsed = JSON.parse(prefStorage.get(STORAGE_KEY) || 'null');
    return {
      mode: THEME_MODES.includes(parsed?.mode) ? parsed.mode : DEFAULTS.mode,
      accent: ACCENT_IDS.has(parsed?.accent) ? parsed.accent : DEFAULTS.accent
    };
  } catch {
    return DEFAULTS;
  }
}

const systemPrefersDark = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;

const ThemeContext = createContext({
  mode: DEFAULTS.mode,
  accent: DEFAULTS.accent,
  resolvedMode: 'light',
  setMode: () => {},
  setAccent: () => {}
});

export const ThemeProvider = ({ children }) => {
  const [{ mode, accent }, setTheme] = useState(readSaved);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  // Follow the device setting live while mode = system.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e) => setSystemDark(e.matches);
    mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange);
    return () => (mq.removeEventListener ? mq.removeEventListener('change', onChange) : mq.removeListener(onChange));
  }, []);

  const resolvedMode = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', resolvedMode);
    root.setAttribute('data-accent', accent);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolvedMode === 'dark' ? BAR_COLORS.dark : BAR_COLORS.light[accent]);
  }, [resolvedMode, accent]);

  const update = useCallback((patch) => {
    // Brief cross-fade so the switch feels deliberate, not jarring.
    const root = document.documentElement;
    root.classList.add('um-theme-switching');
    window.setTimeout(() => root.classList.remove('um-theme-switching'), 320);
    setTheme((prev) => {
      const next = { ...prev, ...patch };
      try {
        prefStorage.set(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* non-fatal */
      }
      return next;
    });
  }, []);

  const setMode = useCallback((value) => THEME_MODES.includes(value) && update({ mode: value }), [update]);
  const setAccent = useCallback((value) => ACCENT_IDS.has(value) && update({ accent: value }), [update]);

  const value = useMemo(() => ({ mode, accent, resolvedMode, setMode, setAccent }), [mode, accent, resolvedMode, setMode, setAccent]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => useContext(ThemeContext);
