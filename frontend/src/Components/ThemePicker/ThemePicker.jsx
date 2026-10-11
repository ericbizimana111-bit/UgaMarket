import React, { useEffect, useRef, useState } from 'react';
import { Check, Monitor, Moon, Palette, Sun, Volume2, VolumeX } from 'lucide-react';
import { THEME_ACCENTS, useTheme } from '../../Context/ThemeContext';
import { useLanguage } from '../../Context/LanguageContext';
import { isSoundOn, playTone, setSoundOn } from '../../utils/sounds';
import './ThemePicker.css';

const MODES = [
  { id: 'light', Icon: Sun },
  { id: 'dark', Icon: Moon },
  { id: 'system', Icon: Monitor }
];

/** Appearance controls: light/dark/auto, colour theme, notification sounds. */
export const ThemePanel = () => {
  const { mode, accent, setMode, setAccent } = useTheme();
  const { t } = useLanguage();
  const [sound, setSound] = useState(isSoundOn);

  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    setSoundOn(next);
    if (next) playTone('message');
  };

  return (
    <div className="tp">
      <fieldset className="tp__group">
        <legend>{t('themeMode')}</legend>
        <div className="tp__modes">
          {MODES.map(({ id, Icon }) => (
            <button
              key={id}
              type="button"
              className={`tp__mode ${mode === id ? 'tp__mode--on' : ''}`}
              onClick={() => setMode(id)}
              aria-pressed={mode === id}
            >
              <Icon size={16} aria-hidden="true" />
              {t(`themeMode_${id}`)}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="tp__group">
        <legend>{t('themeColour')}</legend>
        <div className="tp__swatches">
          {THEME_ACCENTS.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`tp__swatch ${accent === a.id ? 'tp__swatch--on' : ''}`}
              style={{ '--sw': a.swatch }}
              onClick={() => setAccent(a.id)}
              aria-pressed={accent === a.id}
              aria-label={t(`themeAccent_${a.id}`)}
              title={t(`themeAccent_${a.id}`)}
            >
              {accent === a.id && <Check size={16} strokeWidth={3} aria-hidden="true" />}
            </button>
          ))}
        </div>
      </fieldset>

      <button type="button" className="tp__sound" onClick={toggleSound} aria-pressed={sound}>
        {sound ? <Volume2 size={18} aria-hidden="true" /> : <VolumeX size={18} aria-hidden="true" />}
        <span>
          <strong>{t('soundsTitle')}</strong>
          <small>{sound ? t('soundsOn') : t('soundsOff')}</small>
        </span>
        <span className={`tp__switch ${sound ? 'tp__switch--on' : ''}`} aria-hidden="true" />
      </button>
    </div>
  );
};

/** Header button + popover. */
const ThemePicker = () => {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="um-menu-wrap tp-wrap" ref={ref}>
      <button
        type="button"
        className="um-icon-link"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('appearance')}
        title={t('appearance')}
      >
        <Palette size={21} aria-hidden="true" />
      </button>
      {open && (
        <div className="um-dropdown tp-pop" role="dialog" aria-label={t('appearance')}>
          <p className="tp-pop__title">{t('appearance')}</p>
          <ThemePanel />
        </div>
      )}
    </div>
  );
};

export default ThemePicker;
