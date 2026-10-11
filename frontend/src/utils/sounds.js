import { prefStorage } from './consent';

/**
 * Notification tones, synthesised with the Web Audio API (nothing to
 * download, works offline). Each event has its own recognisable sound:
 *
 *   message   soft two-note "pop"            new chat message
 *   order     rising three-note chime         order / delivery / booking update
 *   payment   bright "cash" arpeggio          payment confirmed
 *   alert     gentle single bell              other notifications
 *   warning   low falling pair                payment failed / cancellation
 *   ringback  repeating tone while calling    outgoing call (caller hears it)
 *   ringtone  repeating double ring           incoming call
 *
 * Browsers only allow audio after the visitor has interacted with the page,
 * so the audio context is created/resumed on the first tap or key press.
 * The on/off choice is remembered with preference-cookie consent.
 */

const SOUND_KEY = 'ugamarket_sound';
let ctx = null;
let unlocked = false;

function getContext() {
  if (typeof window === 'undefined') return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!ctx) {
    try {
      ctx = new Ctx();
    } catch {
      return null;
    }
  }
  return ctx;
}

/** Call once at start-up: unlock audio on the first user gesture. */
export function installAudioUnlock() {
  if (typeof window === 'undefined' || unlocked) return;
  const unlock = () => {
    const c = getContext();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
    unlocked = true;
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
}

export function isSoundOn() {
  try {
    return prefStorage.get(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSoundOn(on) {
  prefStorage.set(SOUND_KEY, on ? 'on' : 'off');
}

/** notes: [frequencyHz, startSeconds, durationSeconds, type?, volume?] */
function playNotes(notes, { force = false } = {}) {
  if (!force && !isSoundOn()) return;
  const c = getContext();
  if (!c || c.state === 'closed') return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  const now = c.currentTime + 0.02;
  for (const [freq, start, dur, type = 'sine', vol = 0.22] of notes) {
    try {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now + start);
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(vol, now + start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain).connect(c.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.05);
    } catch {
      /* audio is best-effort */
    }
  }
}

const TONES = {
  message: [
    [880, 0, 0.12, 'sine', 0.2],
    [1175, 0.09, 0.18, 'sine', 0.18]
  ],
  order: [
    [659, 0, 0.22],
    [784, 0.14, 0.22],
    [1047, 0.28, 0.4]
  ],
  payment: [
    [1047, 0, 0.12, 'triangle', 0.22],
    [1319, 0.08, 0.12, 'triangle', 0.22],
    [1568, 0.16, 0.12, 'triangle', 0.22],
    [2093, 0.24, 0.45, 'triangle', 0.2]
  ],
  alert: [[988, 0, 0.5, 'sine', 0.18]],
  warning: [
    [587, 0, 0.25, 'triangle', 0.2],
    [440, 0.2, 0.4, 'triangle', 0.2]
  ]
};

/** Play a one-shot tone by name. */
export function playTone(name, options) {
  const notes = TONES[name] || TONES.alert;
  playNotes(notes, options);
}

/** Tone for a customer notification type. */
export function toneForNotification(type) {
  switch (type) {
    case 'NEW_MESSAGE':
      return 'message';
    case 'PAYMENT_UPDATE':
      return 'payment';
    case 'ORDER_UPDATE':
    case 'DELIVERY_UPDATE':
    case 'SERVICE_UPDATE':
      return 'order';
    case 'SECURITY':
      return 'warning';
    default:
      return 'alert';
  }
}

/**
 * Looping call sounds. Returns a stop() function. Call sounds play even when
 * notification tones are muted (a call must be audible).
 */
export function startLoop(kind) {
  const pattern =
    kind === 'ringtone'
      ? {
          every: 2600,
          notes: [
            [880, 0, 0.35, 'sine', 0.25],
            [740, 0.4, 0.35, 'sine', 0.25],
            [880, 0.9, 0.35, 'sine', 0.25],
            [740, 1.3, 0.35, 'sine', 0.25]
          ]
        }
      : { every: 3000, notes: [[440, 0, 1.0, 'sine', 0.12], [480, 0, 1.0, 'sine', 0.12]] };
  playNotes(pattern.notes, { force: true });
  const timer = window.setInterval(() => playNotes(pattern.notes, { force: true }), pattern.every);
  return () => window.clearInterval(timer);
}
