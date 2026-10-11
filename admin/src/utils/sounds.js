/**
 * Console alert tones, synthesised with the Web Audio API. Each event type
 * has a distinct sound so staff know what happened without looking:
 *
 *   NEW_ORDER            bright rising chime        (most important)
 *   PAYMENT_RECEIVED     "cash" arpeggio
 *   BALANCE_PAID         "cash" arpeggio
 *   NEW_MESSAGE          soft double pop
 *   NEW_SERVICE_REQUEST  two-tone bell
 *   PAYMENT_FAILED / ORDER_CANCELLED / SERVICE_REQUEST_CANCELLED / MISSED_CALL
 *                        low falling pair
 *   incoming call        looping ringtone (always audible, even when muted)
 *
 * Browsers only allow audio after an interaction, so one shared audio
 * context is resumed on the first click/key press.
 */
let ctx = null;

function getContext() {
  const Ctx = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
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

export function installAudioUnlock() {
  const unlock = () => {
    const c = getContext();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
}

function play(notes) {
  const c = getContext();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  const now = c.currentTime + 0.02;
  for (const [freq, start, dur, type = 'sine', vol = 0.25] of notes) {
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
      /* best effort */
    }
  }
}

const CASH = [
  [1047, 0, 0.12, 'triangle'],
  [1319, 0.08, 0.12, 'triangle'],
  [1568, 0.16, 0.12, 'triangle'],
  [2093, 0.24, 0.45, 'triangle', 0.22],
];
const WARNING = [
  [587, 0, 0.25, 'triangle'],
  [440, 0.2, 0.45, 'triangle'],
];

const TONES = {
  NEW_ORDER: [
    [659, 0, 0.2],
    [784, 0.13, 0.2],
    [1047, 0.26, 0.2],
    [1319, 0.39, 0.5],
  ],
  PAYMENT_RECEIVED: CASH,
  BALANCE_PAID: CASH,
  NEW_MESSAGE: [
    [880, 0, 0.12, 'sine', 0.2],
    [1175, 0.09, 0.18, 'sine', 0.18],
  ],
  NEW_SERVICE_REQUEST: [
    [784, 0, 0.35],
    [988, 0.25, 0.5],
  ],
  PAYMENT_FAILED: WARNING,
  ORDER_CANCELLED: WARNING,
  SERVICE_REQUEST_CANCELLED: WARNING,
  MISSED_CALL: WARNING,
  DEFAULT: [[988, 0, 0.45, 'sine', 0.2]],
};

export function playAlert(type) {
  play(TONES[type] || TONES.DEFAULT);
}

/** Looping incoming-call ringtone. Returns stop(). */
export function startRingtone() {
  const ring = [
    [880, 0, 0.35, 'sine', 0.3],
    [740, 0.4, 0.35, 'sine', 0.3],
    [880, 0.9, 0.35, 'sine', 0.3],
    [740, 1.3, 0.35, 'sine', 0.3],
  ];
  play(ring);
  const timer = setInterval(() => play(ring), 2600);
  return () => clearInterval(timer);
}
