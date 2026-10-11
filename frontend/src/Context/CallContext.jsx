import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import apiClient from '../api/client';
import { useAuth } from './AuthContext';
import { useRealtimeEvent } from './RealtimeContext';
import { startLoop, playTone } from '../utils/sounds';

/**
 * Customer -> UgaMarket voice call (WebRTC audio).
 *
 *   idle -> requesting (microphone permission) -> ringing (POST /calls,
 *   staff consoles ring) -> connecting (staff answered; offer/answer/ICE
 *   relayed through the API) -> connected -> ended
 *
 * Audio goes peer-to-peer and is encrypted by WebRTC (DTLS-SRTP). The API
 * only lets this customer exchange signals with the staff member who
 * answered. Microphone access is requested only when the customer taps
 * "Call", and released as soon as the call ends.
 */
const CallContext = createContext(null);

const AUDIO_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false };

export const CallProvider = ({ children }) => {
  const { isAuthenticated } = useAuth();
  const [state, setState] = useState('idle'); // idle|requesting|ringing|connecting|connected|ended
  const [error, setError] = useState(null); // { code, message }
  const [endReason, setEndReason] = useState(null);
  const [agentName, setAgentName] = useState(null);
  const [muted, setMuted] = useState(false);
  const [connectedAt, setConnectedAt] = useState(null);

  const callIdRef = useRef(null);
  const pcRef = useRef(null);
  const streamRef = useRef(null);
  const configRef = useRef({ iceServers: [] });
  const pendingIce = useRef([]);
  const remoteSet = useRef(false);
  const audioRef = useRef(null);
  const stopRing = useRef(null);
  const resetTimer = useRef(null);

  const silenceRing = () => {
    stopRing.current?.();
    stopRing.current = null;
  };

  const cleanup = useCallback(() => {
    silenceRing();
    pcRef.current?.getSenders?.().forEach((s) => s.track && s.track.stop());
    try {
      pcRef.current?.close();
    } catch {
      /* already closed */
    }
    pcRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    pendingIce.current = [];
    remoteSet.current = false;
    if (audioRef.current) audioRef.current.srcObject = null;
    callIdRef.current = null;
    setMuted(false);
    setConnectedAt(null);
  }, []);

  const finish = useCallback(
    (reason) => {
      cleanup();
      setEndReason(reason || 'ENDED');
      setState('ended');
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => {
        setState('idle');
        setEndReason(null);
        setAgentName(null);
      }, 4000);
    },
    [cleanup]
  );

  const signal = useCallback((type, data) => {
    const id = callIdRef.current;
    if (!id) return Promise.resolve();
    return apiClient.post(`/calls/${id}/signal`, { type, data }).catch(() => {});
  }, []);

  // Stop everything if the customer signs out or leaves.
  useEffect(() => {
    if (!isAuthenticated && callIdRef.current) {
      apiClient.post(`/calls/${callIdRef.current}/end`, { reason: 'SIGNED_OUT' }).catch(() => {});
      cleanup();
      setState('idle');
    }
  }, [isAuthenticated, cleanup]);

  useEffect(() => {
    const onUnload = () => {
      const id = callIdRef.current;
      if (id) apiClient.post(`/calls/${id}/end`, { reason: 'PAGE_CLOSED' }).catch(() => {});
    };
    window.addEventListener('pagehide', onUnload);
    return () => window.removeEventListener('pagehide', onUnload);
  }, []);

  const startCall = useCallback(async () => {
    if (state !== 'idle' && state !== 'ended') return;
    setError(null);
    setEndReason(null);
    clearTimeout(resetTimer.current);

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof window.RTCPeerConnection === 'undefined') {
      setError({ code: 'UNSUPPORTED' });
      setState('ended');
      return;
    }

    setState('requesting');
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
    } catch (err) {
      setError({ code: err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ? 'MIC_DENIED' : 'MIC_UNAVAILABLE' });
      setState('ended');
      return;
    }

    try {
      const res = await apiClient.post('/calls');
      callIdRef.current = res?.data?.call?.id;
      configRef.current = res?.data?.config || { iceServers: [] };
      setState('ringing');
      stopRing.current = startLoop('ringback');
    } catch (err) {
      cleanup();
      setError({ code: err?.data?.errors?.[0]?.code || 'FAILED', message: err?.message });
      setState('ended');
    }
  }, [state, cleanup]);

  const hangUp = useCallback(() => {
    const id = callIdRef.current;
    if (id) apiClient.post(`/calls/${id}/end`, { reason: 'HANGUP' }).catch(() => {});
    finish('HANGUP');
  }, [finish]);

  const toggleMute = useCallback(() => {
    const track = streamRef.current?.getAudioTracks?.()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  }, []);

  const dismiss = useCallback(() => {
    clearTimeout(resetTimer.current);
    setState('idle');
    setError(null);
    setEndReason(null);
  }, []);

  // Staff answered: set up the peer connection and send the offer.
  useRealtimeEvent('call:accepted', async (data) => {
    if (!data || data.callId !== callIdRef.current) return;
    silenceRing();
    setAgentName(data.agentName || null);
    setState('connecting');
    try {
      const pc = new RTCPeerConnection({ iceServers: configRef.current.iceServers || [] });
      pcRef.current = pc;
      streamRef.current.getTracks().forEach((track) => pc.addTrack(track, streamRef.current));
      pc.onicecandidate = (e) => e.candidate && signal('ice', e.candidate.toJSON ? e.candidate.toJSON() : e.candidate);
      pc.ontrack = (e) => {
        if (audioRef.current) {
          audioRef.current.srcObject = e.streams[0];
          audioRef.current.play?.().catch(() => {});
        }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setState('connected');
          setConnectedAt(Date.now());
          playTone('alert', { force: true });
        } else if (pc.connectionState === 'failed') {
          hangUp();
          setError({ code: 'CONNECTION_FAILED' });
        }
      };
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await signal('offer', { type: offer.type, sdp: offer.sdp });
    } catch {
      setError({ code: 'CONNECTION_FAILED' });
      hangUp();
    }
  });

  useRealtimeEvent('call:signal', async (data) => {
    const pc = pcRef.current;
    if (!data || data.callId !== callIdRef.current || !pc) return;
    try {
      if (data.type === 'answer') {
        await pc.setRemoteDescription(data.data);
        remoteSet.current = true;
        for (const c of pendingIce.current) await pc.addIceCandidate(c).catch(() => {});
        pendingIce.current = [];
      } else if (data.type === 'ice' && data.data) {
        if (remoteSet.current) await pc.addIceCandidate(data.data).catch(() => {});
        else pendingIce.current.push(data.data);
      }
    } catch {
      /* a bad candidate must not end the call */
    }
  });

  useRealtimeEvent('call:ended', (data) => {
    if (!data || data.callId !== callIdRef.current) return;
    if (data.status === 'MISSED') setError({ code: 'NO_ANSWER' });
    else if (data.status === 'REJECTED') setError({ code: 'BUSY' });
    finish(data.reason || data.status);
  });

  const value = useMemo(
    () => ({ state, error, endReason, agentName, muted, connectedAt, startCall, hangUp, toggleMute, dismiss, available: isAuthenticated }),
    [state, error, endReason, agentName, muted, connectedAt, startCall, hangUp, toggleMute, dismiss, isAuthenticated]
  );

  return (
    <CallContext.Provider value={value}>
      {children}
      {/* Remote audio (hidden). playsInline keeps iOS from going fullscreen. */}
      <audio ref={audioRef} autoPlay playsInline hidden />
    </CallContext.Provider>
  );
};

export const useCall = () =>
  useContext(CallContext) || {
    state: 'idle',
    available: false,
    startCall: () => {},
    hangUp: () => {},
    toggleMute: () => {},
    dismiss: () => {}
  };
