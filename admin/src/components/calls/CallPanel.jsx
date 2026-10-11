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
export default function CallPanel() {
  const { ringing, active, muted, answer, decline, hangUp, toggleMute } = useCalls();
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
              {active.customer?.phone} · {active.state === 'connected' ? elapsed : 'Connecting…'}
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
