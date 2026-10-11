import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Mic, MicOff, MessageCircle, Phone, PhoneIncoming, PhoneOff } from 'lucide-react';
import { useCalls } from '../../context/CallContext';
import './CallPanel.css';

function useElapsed(since) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return null;
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Incoming-call card(s) and the in-call bar, shown on every console page. */
function Meter({ label, level }) {
  return (
    <span className="callmeter">
      <small>{label}</small>
      <span className="callmeter__bar" aria-hidden="true">
        <span style={{ width: `${Math.round((level || 0) * 100)}%` }} />
      </span>
    </span>
  );
}

const QUALITY = { good: 'Good connection', fair: 'Fair connection', poor: 'Weak connection' };

export default function CallPanel() {
  const { ringing, active, muted, answer, decline, hangUp, toggleMute, health, microphones, micId, changeMicrophone } = useCalls();
  const elapsed = useElapsed(active?.since);

  if (!active && ringing.length === 0) return null;

  return (
    <div className="callpanel" aria-live="assertive">
      {active ? (
        <div className="callcard callcard--active" role="dialog" aria-label="Call in progress">
          <span className="callcard__icon">
            <Phone size={20} aria-hidden="true" />
          </span>
          <div className="callcard__body">
            <strong>{active.customer?.fullName || 'Customer'}</strong>
            <span>
              {active.customer?.phone} ·{' '}
              {active.state === 'connected'
                ? elapsed
                : active.state === 'reconnecting'
                  ? 'Reconnecting… (network changed)'
                  : active.state === 'calling'
                    ? 'Calling… (ringing on their UgaMarket)'
                    : 'Connecting…'}
            </span>
          </div>
          <Link to={`/messages?customer=${active.customer?.id}`} className="callcard__btn" title="Open chat with this customer" aria-label="Open chat">
            <MessageCircle size={18} aria-hidden="true" />
          </Link>
          <button type="button" className={`callcard__btn ${muted ? 'callcard__btn--on' : ''}`} onClick={toggleMute} aria-pressed={muted} aria-label={muted ? 'Unmute' : 'Mute'}>
            {muted ? <MicOff size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
          </button>
          <button type="button" className="callcard__btn callcard__btn--end" onClick={hangUp} aria-label="End call">
            <PhoneOff size={18} aria-hidden="true" />
          </button>
          {health && active.state !== 'calling' && (
            <div className="callhealth">
              <div className="callhealth__meters">
                <Meter label="Customer's microphone" level={health.remoteLevel} />
                <Meter label="Your microphone" level={health.micLevel} />
              </div>
              {active.state === 'connected' && (
                <small className={`callhealth__quality callhealth__quality--${health.quality}`}>
                  {QUALITY[health.quality]}
                  {health.rttMs != null && ` · ${health.rttMs} ms`}
                  {health.lossPct > 0 && ` · ${health.lossPct}% lost`}
                </small>
              )}
              {active.state === 'connected' && health.remoteSilent && (
                <p className="callhealth__warn">
                  No sound is arriving from the customer&apos;s microphone. Ask them (in chat) to check their mic isn&apos;t muted or blocked, or to pick
                  another microphone in their call panel.
                </p>
              )}
              {active.state === 'connected' && health.quality === 'poor' && (
                <p className="callhealth__warn">The connection is weak (often the customer&apos;s mobile data). Sound may break up or crackle.</p>
              )}
              {active.state === 'connected' && health.micSilent && !muted && (
                <p className="callhealth__warn">Your microphone is picking up nothing. Check it or choose another below.</p>
              )}
              {microphones.length > 1 && (
                <label className="callhealth__mic">
                  Microphone
                  <select value={micId} onChange={(e) => changeMicrophone(e.target.value)}>
                    {microphones.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <small className="callhealth__tip">
                Testing on your own? Use two devices in different rooms, or earphones. One computer (or two phones side by side) playing both ends
                confuses echo cancellation and turns the voice into noise.
              </small>
            </div>
          )}
        </div>
      ) : null}

      {!active &&
        ringing.slice(0, 3).map((call) => (
          <div key={call.callId} className="callcard callcard--ringing" role="alertdialog" aria-label={`Incoming call from ${call.customer?.fullName}`}>
            <span className="callcard__icon callcard__icon--pulse">
              <PhoneIncoming size={20} aria-hidden="true" />
            </span>
            <div className="callcard__body">
              <small>Incoming customer call</small>
              <strong>{call.customer?.fullName || 'Customer'}</strong>
              <span>{call.customer?.phone}</span>
            </div>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => decline(call)}>
              Decline
            </button>
            <button type="button" className="btn btn--primary btn--sm callcard__answer" onClick={() => answer(call)}>
              <Phone size={15} aria-hidden="true" /> Answer
            </button>
          </div>
        ))}
    </div>
  );
}
