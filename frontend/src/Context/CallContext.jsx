import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import apiClient from '../api/client';
import { useAuth } from './AuthContext';
import { useRealtimeEvent } from './RealtimeContext';
import { useToast } from '../Components/Toast/Toast';
import { startLoop, playTone } from '../utils/sounds';
import { listMicrophones, startCallDiagnostics, switchMicrophone, tuneAudioSender } from '../utils/callDiagnostics';

/**
 * Voice calls between the customer and UgaMarket (WebRTC audio), both ways:
 *
 *   Customer calls:  requesting (mic) -> ringing (POST /calls; staff consoles
 *                    ring) -> connecting (staff answered; WE send the offer)
 *                    -> connected -> ended
 *   Staff call us:   incoming (ringtone + Accept/Decline) -> connecting
 *                    (POST /calls/:id/accept; staff send the offer, WE answer)
 *                    -> connected -> ended
 *
 * Audio flows peer-to-peer, encrypted by WebRTC (DTLS-SRTP); the API only
 * relays set-up messages between the two participants of a call. The
 * microphone is requested only when the customer taps Call/Accept and is
 * released as soon as the call ends.
 */
const CallContext = createContext(null);

const AUDIO_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false };

const supported = () =>
  typeof window !== 'undefined' && window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia) && typeof window.RTCPeerConnection !== 'undefined';

export const CallProvider = ({ children }) => {
  const { isAuthenticated } = useAuth();
  const toast = useToast();
  // idle | requesting | ringing | incoming | connecting | connected | ended
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null); // { code, message }
  const [endReason, setEndReason] = useState(null);
  const [agentName, setAgentName] = useState(null);
  const [muted, setMuted] = useState(false);
  const [connectedAt, setConnectedAt] = useState(null);
  // Live health: my mic level, the other side's level, connection quality.
  const [health, setHealth] = useState(null);
  const [microphones, setMicrophones] = useState([]);
  const [micId, setMicId] = useState('');
  const diagRef = useRef(null);

  const callIdRef = useRef(null);
  const roleRef = useRef(null); // 'caller' | 'callee'
  const pcRef = useRef(null);
  const streamRef = useRef(null);
  const configRef = useRef({ iceServers: [] });
  const pendingIce = useRef([]);
  const remoteSet = useRef(false);
  const audioRef = useRef(null);
  const stopRing = useRef(null);
  const resetTimer = useRef(null);
  const stateRef = useRef('idle');
  // Network changes (Wi‑Fi <-> mobile data, weak signal): renegotiate instead of dropping.
  const restartAttempts = useRef(0);
  const disconnectTimer = useRef(null);
  const MAX_RESTARTS = 4;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const silenceRing = () => {
    stopRing.current?.();
    stopRing.current = null;
  };

  const cleanup = useCallback(() => {
    silenceRing();
    clearTimeout(disconnectTimer.current);
    restartAttempts.current = 0;
    diagRef.current?.stop();
    diagRef.current = null;
    setHealth(null);
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
    roleRef.current = null;
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
        setError(null);
      }, 5000);
    },
    [cleanup]
  );

  const signal = useCallback((type, data) => {
    const id = callIdRef.current;
    if (!id) return Promise.resolve();
    return apiClient.post(`/calls/${id}/signal`, { type, data }).catch(() => {});
  }, []);

  const hangUp = useCallback(() => {
    const id = callIdRef.current;
    if (id) apiClient.post(`/calls/${id}/end`, { reason: 'HANGUP' }).catch(() => {});
    finish('HANGUP');
  }, [finish]);

  /** Peer connection shared by both directions. */
  const createPeer = useCallback(() => {
    const pc = new RTCPeerConnection({ iceServers: configRef.current.iceServers || [] });
    pcRef.current = pc;
    streamRef.current.getTracks().forEach((track) => pc.addTrack(track, streamRef.current));
    pc.onicecandidate = (e) => e.candidate && signal('ice', e.candidate.toJSON ? e.candidate.toJSON() : e.candidate);
    pc.ontrack = (e) => {
      const el = audioRef.current;
      if (!el) return;
      el.srcObject = e.streams[0] || new MediaStream([e.track]);
      el.play?.().catch(() => {});
    };
    const onState = () => {
      const s = pc.connectionState || pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') {
        clearTimeout(disconnectTimer.current);
        restartAttempts.current = 0;
        if (stateRef.current === 'reconnecting') {
          setState('connected');
        } else if (stateRef.current !== 'connected') {
          setState('connected');
          setConnectedAt(Date.now());
          tuneAudioSender(pc);
          playTone('alert', { force: true });
          audioRef.current?.play?.().catch(() => {});
        }
      } else if (s === 'disconnected') {
        // Often recovers by itself within a few seconds; otherwise renegotiate.
        clearTimeout(disconnectTimer.current);
        disconnectTimer.current = setTimeout(() => {
          const now = pc.connectionState || pc.iceConnectionState;
          if (now === 'disconnected' || now === 'failed') reconnectRef.current?.();
        }, 3000);
      } else if (s === 'failed') {
        reconnectRef.current?.();
      }
    };
    pc.onconnectionstatechange = onState;
    pc.oniceconnectionstatechange = onState;
    diagRef.current?.stop();
    diagRef.current = startCallDiagnostics({ pc, stream: streamRef.current, onUpdate: setHealth });
    listMicrophones().then((list) => {
      setMicrophones(list);
      const current = streamRef.current?.getAudioTracks?.()[0]?.getSettings?.().deviceId;
      if (current) setMicId(current);
    });
    return pc;
  }, [signal]);

  /**
   * ICE restart: the caller renegotiates with fresh network paths (and TURN
   * relays); the answering side asks the caller to do so.
   */
  const reconnectRef = useRef(null);
  reconnectRef.current = async () => {
    const pc = pcRef.current;
    if (!pc || !callIdRef.current) return;
    if (restartAttempts.current >= MAX_RESTARTS) {
      setError({ code: 'CONNECTION_FAILED' });
      hangUp();
      return;
    }
    restartAttempts.current += 1;
    if (stateRef.current === 'connected') setState('reconnecting');
    try {
      if (roleRef.current === 'caller') {
        pc.restartIce?.();
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        await signal('offer', { type: offer.type, sdp: offer.sdp });
      } else {
        await signal('restart', null);
      }
    } catch {
      /* the next state change retries */
    }
    // If nothing improves, try again.
    clearTimeout(disconnectTimer.current);
    disconnectTimer.current = setTimeout(() => {
      const now = pc.connectionState || pc.iceConnectionState;
      if (now !== 'connected' && now !== 'completed') reconnectRef.current?.();
    }, 8000);
  };

  /** After renegotiating, return to "connected" if the link never dropped. */
  const settleIfUp = (pc) => {
    const s = pc.connectionState || pc.iceConnectionState;
    if ((s === 'connected' || s === 'completed') && stateRef.current === 'reconnecting') {
      clearTimeout(disconnectTimer.current);
      restartAttempts.current = 0;
      setState('connected');
    }
  };

  const applyIce = async (pc, candidate) => {
    if (remoteSet.current) await pc.addIceCandidate(candidate).catch(() => {});
    else pendingIce.current.push(candidate);
  };

  const flushIce = async (pc) => {
    remoteSet.current = true;
    for (const c of pendingIce.current) await pc.addIceCandidate(c).catch(() => {});
    pendingIce.current = [];
  };

  // Stop everything if the customer signs out.
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

  const getMicrophone = async () => {
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
      return true;
    } catch (err) {
      setError({ code: err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ? 'MIC_DENIED' : 'MIC_UNAVAILABLE' });
      return false;
    }
  };

  // ---------------- Customer calls UgaMarket ----------------
  const startCall = useCallback(async () => {
    if (state !== 'idle' && state !== 'ended') return;
    setError(null);
    setEndReason(null);
    clearTimeout(resetTimer.current);

    if (!supported()) {
      setError({ code: 'UNSUPPORTED' });
      setState('ended');
      return;
    }
    setState('requesting');
    if (!(await getMicrophone())) {
      setState('ended');
      return;
    }
    try {
      const res = await apiClient.post('/calls');
      callIdRef.current = res?.data?.call?.id;
      roleRef.current = 'caller';
      configRef.current = res?.data?.config || { iceServers: [] };
      setState('ringing');
      stopRing.current = startLoop('ringback');
    } catch (err) {
      cleanup();
      setError({ code: err?.data?.errors?.[0]?.code || 'FAILED', message: err?.message });
      setState('ended');
    }
  }, [state, cleanup]);

  // ---------------- UgaMarket calls the customer ----------------
  useRealtimeEvent('call:incoming', (data) => {
    if (!data?.callId) return;
    const busy = !['idle', 'ended'].includes(stateRef.current);
    if (busy) {
      // Already on a call: tell the caller we are busy.
      apiClient.post(`/calls/${data.callId}/reject`).catch(() => {});
      return;
    }
    clearTimeout(resetTimer.current);
    setError(null);
    setEndReason(null);
    callIdRef.current = data.callId;
    roleRef.current = 'callee';
    setAgentName(data.agentName || null);
    setState('incoming');
    silenceRing();
    stopRing.current = startLoop('ringtone');
    toast?.showToast?.(`📞 ${data.agentName || 'UgaMarket'} is calling you`, { type: 'info', duration: 8000 });
  });

  const acceptIncoming = useCallback(async () => {
    const id = callIdRef.current;
    if (!id || stateRef.current !== 'incoming') return;
    silenceRing();
    if (!supported()) {
      apiClient.post(`/calls/${id}/reject`).catch(() => {});
      cleanup();
      setError({ code: 'UNSUPPORTED' });
      setState('ended');
      return;
    }
    setState('connecting');
    if (!(await getMicrophone())) {
      apiClient.post(`/calls/${id}/reject`).catch(() => {});
      cleanup();
      setState('ended');
      return;
    }
    try {
      const cfg = await apiClient.get('/calls/config');
      configRef.current = cfg?.data || { iceServers: [] };
      // Ready for the staff member's offer before telling them we answered.
      createPeer();
      await apiClient.post(`/calls/${id}/accept`);
    } catch (err) {
      cleanup();
      setError({ code: err?.data?.errors?.[0]?.code === 'CALL_UNAVAILABLE' ? 'CALL_GONE' : 'FAILED', message: err?.message });
      setState('ended');
    }
  }, [cleanup, createPeer]);

  const declineIncoming = useCallback(() => {
    const id = callIdRef.current;
    if (id) apiClient.post(`/calls/${id}/reject`).catch(() => {});
    cleanup();
    setState('idle');
    setAgentName(null);
  }, [cleanup]);

  // Staff answered OUR call: we make the offer.
  useRealtimeEvent('call:accepted', async (data) => {
    if (!data || data.callId !== callIdRef.current || roleRef.current !== 'caller') return;
    silenceRing();
    setAgentName(data.agentName || null);
    setState('connecting');
    try {
      const pc = createPeer();
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
      if (data.type === 'answer' && roleRef.current === 'caller') {
        await pc.setRemoteDescription(data.data);
        await flushIce(pc);
        setTimeout(() => settleIfUp(pc), 1500);
      } else if (data.type === 'offer' && roleRef.current === 'callee') {
        await pc.setRemoteDescription(data.data);
        await flushIce(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await signal('answer', { type: answer.type, sdp: answer.sdp });
        setTimeout(() => settleIfUp(pc), 1500);
      } else if (data.type === 'restart' && roleRef.current === 'caller') {
        await reconnectRef.current?.();
      } else if (data.type === 'ice' && data.data) {
        await applyIce(pc, data.data);
      }
    } catch {
      /* a bad candidate must not end the call */
    }
  });

  useRealtimeEvent('call:ended', (data) => {
    if (!data || data.callId !== callIdRef.current) return;
    const wasIncoming = stateRef.current === 'incoming';
    if (wasIncoming) setError({ code: 'MISSED_INCOMING' });
    else if (data.status === 'MISSED' && roleRef.current === 'caller') setError({ code: 'NO_ANSWER' });
    else if (data.status === 'REJECTED' && roleRef.current === 'caller') setError({ code: 'BUSY' });
    finish(data.reason || data.status);
  });

  const toggleMute = useCallback(() => {
    const track = streamRef.current?.getAudioTracks?.()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  }, []);

  /** Change microphone mid-call (e.g. the default one picks up nothing). */
  const changeMicrophone = useCallback(
    async (deviceId) => {
      if (!deviceId || !pcRef.current) return;
      try {
        const next = await switchMicrophone({ pc: pcRef.current, oldStream: streamRef.current, deviceId, muted });
        streamRef.current = next;
        diagRef.current?.setStream(next);
        setMicId(deviceId);
      } catch {
        toast?.showToast?.('That microphone could not be used.', { type: 'error' });
      }
    },
    [muted, toast]
  );

  const dismiss = useCallback(() => {
    clearTimeout(resetTimer.current);
    setState('idle');
    setError(null);
    setEndReason(null);
    setAgentName(null);
  }, []);

  const value = useMemo(
    () => ({
      state,
      error,
      endReason,
      agentName,
      muted,
      connectedAt,
      startCall,
      acceptIncoming,
      declineIncoming,
      hangUp,
      toggleMute,
      dismiss,
      health,
      microphones,
      micId,
      changeMicrophone,
      available: isAuthenticated
    }),
    [state, error, endReason, agentName, muted, connectedAt, startCall, acceptIncoming, declineIncoming, hangUp, toggleMute, dismiss, health, microphones, micId, changeMicrophone, isAuthenticated]
  );

  return (
    <CallContext.Provider value={value}>
      {children}
      {/* Remote audio. playsInline keeps iOS from going fullscreen. */}
      <audio ref={audioRef} autoPlay playsInline data-testid="call-remote-audio" style={{ display: 'none' }} />
    </CallContext.Provider>
  );
};

export const useCall = () =>
  useContext(CallContext) || {
    state: 'idle',
    available: false,
    startCall: () => {},
    acceptIncoming: () => {},
    declineIncoming: () => {},
    hangUp: () => {},
    toggleMute: () => {},
    dismiss: () => {}
  };
