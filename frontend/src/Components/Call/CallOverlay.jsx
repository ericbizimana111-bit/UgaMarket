import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Headset, Mic, MicOff, Phone, PhoneOff, X } from 'lucide-react';
import { useCall } from '../../Context/CallContext';
import { useLanguage } from '../../Context/LanguageContext';
import './Call.css';

const ERROR_KEYS = {
  UNSUPPORTED: 'callErrUnsupported',
  MIC_DENIED: 'callErrMicDenied',
  MIC_UNAVAILABLE: 'callErrMicUnavailable',
  NO_AGENT_ONLINE: 'callErrOffline',
  NO_ANSWER: 'callErrNoAnswer',
  BUSY: 'callErrBusy',
  CALL_RATE_LIMITED: 'callErrRateLimited',
  CALL_IN_PROGRESS: 'callErrInProgress',
  CONNECTION_FAILED: 'callErrConnection',
  MISSED_INCOMING: 'callErrMissedIncoming',
  CALL_GONE: 'callErrGone',
  FAILED: 'callErrGeneric'
};

function useElapsed(since) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  if (!since) return '00:00';
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const Meter = ({ label, level }) => (
  <span className="um-call__meter">
    <small>{label}</small>
    <span className="um-call__bar" aria-hidden="true">
      <span style={{ width: `${Math.round((level || 0) * 100)}%` }} />
    </span>
  </span>
);

/** Floating call panel, shown on every page while a call is in progress. */
const CallOverlay = () => {
  const { state, error, agentName, muted, connectedAt, hangUp, toggleMute, dismiss, acceptIncoming, declineIncoming, health, microphones, micId, changeMicrophone } = useCall();
  const { t } = useLanguage();
  const elapsed = useElapsed(connectedAt);

  if (state === 'idle') return null;

  const status = {
    requesting: t('callAllowMic'),
    ringing: t('callRinging'),
    incoming: t('callIncoming'),
    connecting: t('callConnecting'),
    connected: elapsed,
    ended: error ? t(ERROR_KEYS[error.code] || 'callErrGeneric') : t('callEnded')
  }[state];

  const live = state === 'ringing' || state === 'incoming' || state === 'connecting' || state === 'connected';

  return (
    <div className={`um-call um-call--${state}`} role="dialog" aria-live="polite" aria-label={t('callSupport')}>
      <span className={`um-call__avatar ${live ? 'um-call__avatar--pulse' : ''}`} aria-hidden="true">
        <Headset size={22} />
      </span>
      <div className="um-call__text">
        <strong>
          {state === 'incoming'
            ? t('callIncomingFrom', { name: agentName || 'UgaMarket' })
            : agentName
              ? t('callWithAgent', { name: agentName })
              : t('callUgaMarketSupport')}
        </strong>
        <span className="um-call__status">{status}</span>
        {state === 'ended' && error && (error.code === 'NO_AGENT_ONLINE' || error.code === 'NO_ANSWER' || error.code === 'BUSY') && (
          <Link to="/account/messages" className="um-call__link" onClick={dismiss}>
            {t('callLeaveMessage')}
          </Link>
        )}
      </div>
      <div className="um-call__actions">
        {state === 'connected' && (
          <button
            type="button"
            className={`um-call__btn ${muted ? 'um-call__btn--on' : ''}`}
            onClick={toggleMute}
            aria-pressed={muted}
            aria-label={muted ? t('callUnmute') : t('callMute')}
          >
            {muted ? <MicOff size={20} aria-hidden="true" /> : <Mic size={20} aria-hidden="true" />}
          </button>
        )}
        {state === 'incoming' ? (
          <>
            <button type="button" className="um-call__btn um-call__btn--hangup" onClick={declineIncoming} aria-label={t('callDecline')} title={t('callDecline')}>
              <PhoneOff size={20} aria-hidden="true" />
            </button>
            <button type="button" className="um-call__btn um-call__btn--answer" onClick={acceptIncoming} aria-label={t('callAccept')} title={t('callAccept')}>
              <Phone size={20} aria-hidden="true" />
            </button>
          </>
        ) : state === 'ended' ? (
          <button type="button" className="um-call__btn" onClick={dismiss} aria-label={t('close')}>
            <X size={20} aria-hidden="true" />
          </button>
        ) : (
          <button type="button" className="um-call__btn um-call__btn--hangup" onClick={hangUp} aria-label={t('callHangUp')}>
            <PhoneOff size={20} aria-hidden="true" />
          </button>
        )}
      </div>

      {(state === 'connecting' || state === 'connected') && health && (
        <div className="um-call__health">
          <div className="um-call__meters">
            <Meter label={t('callMeterYou')} level={health.micLevel} />
            <Meter label={agentName || 'UgaMarket'} level={health.remoteLevel} />
          </div>
          {state === 'connected' && health.micSilent && !muted && <p className="um-call__warn">{t('callWarnMicSilent')}</p>}
          {state === 'connected' && health.remoteSilent && <p className="um-call__warn">{t('callWarnRemoteSilent')}</p>}
          {state === 'connected' && health.quality === 'poor' && <p className="um-call__warn">{t('callWarnPoor')}</p>}
          {microphones.length > 1 && (
            <label className="um-call__mic">
              <span>{t('callMicrophone')}</span>
              <select className="form-select" value={micId} onChange={(e) => changeMicrophone(e.target.value)}>
                {microphones.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="um-call__tip">{t('callTipHeadphones')}</p>
        </div>
      )}
    </div>
  );
};

export default CallOverlay;
