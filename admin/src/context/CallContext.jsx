import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import api from '../services/api';
import { useAuth } from './AuthContext';
import { useRealtimeEvent } from './RealtimeContext';
import { useToast } from '../components/feedback/Toast';
import { startRingback, startRingtone } from '../utils/sounds';
import { listMicrophones, startCallDiagnostics, switchMicrophone, tuneAudioSender } from '../utils/callDiagnostics';

/**
 * Staff side of voice calls (WebRTC audio), both directions:
 *
 *  Customer calls in:  call:incoming -> every console rings -> Answer
 *                      (POST /admin/calls/:id/accept; first answer wins,
 *                      others stop on call:taken) -> customer sends the
 *                      offer, WE answer.
 *  Staff call out:     callCustomer() -> POST /admin/calls (the customer's
 *                      UgaMarket rings) -> call:accepted -> WE send the
 *                      offer, the customer answers.
 *
 * ICE candidates flow both ways through the API, which relays only between
 * the two participants of the call.
 */
const CallContext = createContext(null);

const AUDIO = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false };

const supported = () => window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia) && typeof window.RTCPeerConnection !== 'undefined';

export function CallProvider({ children }) {
  const { admin, isAuthenticated } = useAuth();
  const { showToast } = useToast();
  const [ringing, setRinging] = useState([]); // incoming: [{ callId, customer, createdAt }]
  // { callId, customer, role: 'caller'|'callee', state: 'calling'|'connecting'|'connected', since }
  const [active, setActive] = useState(null);
  const [muted, setMuted] = useState(false);
  const [health, setHealth] = useState(null);
  const [microphones, setMicrophones] = useState([]);
  const [micId, setMicId] = useState('');
  const diagRef = useRef(null);
  // Network changes: renegotiate (ICE restart) instead of dropping the call.
  const restartAttempts = useRef(0);
  const disconnectTimer = useRef(null);
  const reconnectRef = useRef(null);
  const MAX_RESTARTS = 4;

  const pcRef = useRef(null);
  const streamRef = useRef(null);
  const callIdRef = useRef(null);
  const roleRef = useRef(null);
  const configRef = useRef({ iceServers: [] });
  const pendingIce = useRef([]);
  const remoteSet = useRef(false);
  const audioRef = useRef(null);
  const stopRing = useRef(null);
  const stopRingback = useRef(null);

  // Incoming ringtone while anything rings and we are not on a call.
  useEffect(() => {
    if (ringing.length > 0 && !active) {
      if (!stopRing.current) stopRing.current = startRingtone();
    } else if (stopRing.current) {
      stopRing.current();
      stopRing.current = null;
    }
  }, [ringing.length, active]);

  // Ringback while our outgoing call rings at the customer.
  const calling = active?.state === 'calling';
  useEffect(() => {
    if (calling) {
      if (!stopRingback.current) stopRingback.current = startRingback();
    } else if (stopRingback.current) {
      stopRingback.current();
      stopRingback.current = null;
    }
  }, [calling]);

  useEffect(
    () => () => {
      stopRing.current?.();
      stopRingback.current?.();
    },
    [],
  );

  /** Stop the microphone and close the connection (no state updates). */
  const releaseMedia = useCallback(() => {
    clearTimeout(disconnectTimer.current);
    restartAttempts.current = 0;
    diagRef.current?.stop();
    diagRef.current = null;
    try {
      pcRef.current?.close();
    } catch {
      /* closed */
    }
    pcRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    pendingIce.current = [];
    remoteSet.current = false;
    callIdRef.current = null;
    roleRef.current = null;
    if (audioRef.current) audioRef.current.srcObject = null;
  }, []);

  const cleanup = useCallback(() => {
    releaseMedia();
    setHealth(null);
    setMuted(false);
    setActive(null);
  }, [releaseMedia]);

  // Signing out drops any ringing/active call (reset during render, media
  // released in the effect below).
  const [seenAuth, setSeenAuth] = useState(isAuthenticated);
  if (seenAuth !== isAuthenticated) {
    setSeenAuth(isAuthenticated);
    if (!isAuthenticated) {
      setRinging([]);
      setActive(null);
      setMuted(false);
    }
  }
  useEffect(() => {
    if (!isAuthenticated) releaseMedia();
  }, [isAuthenticated, releaseMedia]);

  const signal = useCallback((type, data) => {
    const id = callIdRef.current;
    if (!id) return Promise.resolve();
    return api.post(`/admin/calls/${id}/signal`, { type, data }).catch(() => {});
  }, []);

  const hangUp = useCallback(() => {
    const id = callIdRef.current;
    if (id) api.post(`/admin/calls/${id}/end`, { reason: 'HANGUP' }).catch(() => {});
    cleanup();
  }, [cleanup]);

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
        setActive((a) =>
          !a ? a : a.state === 'reconnecting' ? { ...a, state: 'connected' } : a.state !== 'connected' ? { ...a, state: 'connected', since: Date.now() } : a,
        );
        audioRef.current?.play?.().catch(() => {});
        tuneAudioSender(pc);
      } else if (s === 'disconnected') {
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

  reconnectRef.current = async () => {
    const pc = pcRef.current;
    if (!pc || !callIdRef.current) return;
    if (restartAttempts.current >= MAX_RESTARTS) {
      showToast('The call connection was lost. Check the internet connection (a TURN relay may be needed).', { type: 'error' });
      hangUp();
      return;
    }
    restartAttempts.current += 1;
    setActive((a) => (a && a.state === 'connected' ? { ...a, state: 'reconnecting' } : a));
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
      /* retried below */
    }
    clearTimeout(disconnectTimer.current);
    disconnectTimer.current = setTimeout(() => {
      const now = pc.connectionState || pc.iceConnectionState;
      if (now !== 'connected' && now !== 'completed') reconnectRef.current?.();
    }, 8000);
  };

  /** After renegotiating, return to "connected" if the link never dropped. */
  const settleIfUp = (pc) => {
    const s = pc.connectionState || pc.iceConnectionState;
    if (s === 'connected' || s === 'completed') {
      clearTimeout(disconnectTimer.current);
      restartAttempts.current = 0;
      setActive((a) => (a && a.state === 'reconnecting' ? { ...a, state: 'connected' } : a));
    }
  };

  const flushIce = async (pc) => {
    remoteSet.current = true;
    for (const c of pendingIce.current) await pc.addIceCandidate(c).catch(() => {});
    pendingIce.current = [];
  };

  const getMicrophone = async () => {
    if (!supported()) {
      showToast('This browser cannot make calls. Use an up-to-date Chrome, Edge, Firefox or Safari over https.', { type: 'error' });
      return false;
    }
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia(AUDIO);
      return true;
    } catch {
      showToast('Microphone access is blocked. Allow the microphone for this site and try again.', { type: 'error' });
      return false;
    }
  };

  // Closing or reloading the console tab ends the call cleanly.
  useEffect(() => {
    const onUnload = () => {
      const id = callIdRef.current;
      if (id) api.post(`/admin/calls/${id}/end`, { reason: 'PAGE_CLOSED' }).catch(() => {});
    };
    window.addEventListener('pagehide', onUnload);
    return () => window.removeEventListener('pagehide', onUnload);
  }, []);

  // ---------------- Customer calls in ----------------
  useRealtimeEvent('call:incoming', (data) => {
    if (!data?.callId) return;
    setRinging((prev) => (prev.some((c) => c.callId === data.callId) ? prev : [...prev, data]));
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState === 'hidden') {
      try {
        const n = new Notification(`Incoming call: ${data.customer?.fullName || 'Customer'}`, {
          body: 'Open the console to answer.',
          tag: data.callId,
          icon: '/logo.png',
          requireInteraction: true,
        });
        n.onclick = () => window.focus();
      } catch {
        /* needs a service worker on some browsers */
      }
    }
  });

  useRealtimeEvent('call:taken', (data) => {
    if (data) setRinging((prev) => prev.filter((c) => c.callId !== data.callId));
  });

  const answer = useCallback(
    async (call) => {
      if (active) return;
      if (!(await getMicrophone())) return;
      // The peer connection must exist before the customer's offer arrives.
      callIdRef.current = call.callId;
      roleRef.current = 'callee';
      try {
        configRef.current = (await api.get('/admin/calls/config'))?.data || { iceServers: [] };
        createPeer();
        setActive({ callId: call.callId, customer: call.customer, role: 'callee', state: 'connecting', since: null });
        setRinging((prev) => prev.filter((c) => c.callId !== call.callId));
        await api.post(`/admin/calls/${call.callId}/accept`);
      } catch (err) {
        showToast(err?.message || 'Could not answer the call.', { type: 'error' });
        setRinging((prev) => prev.filter((c) => c.callId !== call.callId));
        cleanup();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, cleanup, createPeer, showToast],
  );

  const decline = useCallback(async (call) => {
    setRinging((prev) => prev.filter((c) => c.callId !== call.callId));
    try {
      await api.post(`/admin/calls/${call.callId}/reject`);
    } catch {
      /* already answered elsewhere or ended */
    }
  }, []);

  // ---------------- Staff call a customer ----------------
  const callCustomer = useCallback(
    async (customer) => {
      if (!customer?.id) return;
      if (active || callIdRef.current) {
        showToast('Finish your current call first.', { type: 'warning' });
        return;
      }
      if (!(await getMicrophone())) return;
      try {
        const res = await api.post('/admin/calls', { userId: customer.id });
        callIdRef.current = res?.data?.call?.id;
        roleRef.current = 'caller';
        configRef.current = res?.data?.config || { iceServers: [] };
        setActive({ callId: callIdRef.current, customer, role: 'caller', state: 'calling', since: null });
      } catch (err) {
        releaseMedia();
        showToast(err?.message || 'Could not call the customer.', { type: err?.status === 409 ? 'warning' : 'error', duration: 9000 });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, releaseMedia, showToast],
  );

  // The customer answered our call: we send the offer.
  useRealtimeEvent('call:accepted', async (data) => {
    if (!data || data.callId !== callIdRef.current || roleRef.current !== 'caller') return;
    setActive((a) => (a ? { ...a, state: 'connecting' } : a));
    try {
      const pc = createPeer();
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await signal('offer', { type: offer.type, sdp: offer.sdp });
    } catch {
      showToast('The call could not connect.', { type: 'error' });
      hangUp();
    }
  });

  // ---------------- Both directions ----------------
  useRealtimeEvent('call:signal', async (data) => {
    const pc = pcRef.current;
    if (!data || data.callId !== callIdRef.current || !pc) return;
    try {
      if (data.type === 'offer' && roleRef.current === 'callee') {
        await pc.setRemoteDescription(data.data);
        await flushIce(pc);
        const reply = await pc.createAnswer();
        await pc.setLocalDescription(reply);
        await signal('answer', { type: reply.type, sdp: reply.sdp });
        setTimeout(() => settleIfUp(pc), 1500);
      } else if (data.type === 'answer' && roleRef.current === 'caller') {
        await pc.setRemoteDescription(data.data);
        await flushIce(pc);
        setTimeout(() => settleIfUp(pc), 1500);
      } else if (data.type === 'restart' && roleRef.current === 'caller') {
        await reconnectRef.current?.();
      } else if (data.type === 'ice' && data.data) {
        if (remoteSet.current) await pc.addIceCandidate(data.data).catch(() => {});
        else pendingIce.current.push(data.data);
      }
    } catch {
      /* one bad signal must not drop the call */
    }
  });

  useRealtimeEvent('call:ended', (data) => {
    if (!data) return;
    setRinging((prev) => prev.filter((c) => c.callId !== data.callId));
    if (data.callId !== callIdRef.current) return;
    const outgoing = roleRef.current === 'caller';
    const message =
      outgoing && data.status === 'REJECTED'
        ? 'The customer declined the call.'
        : outgoing && data.status === 'MISSED'
          ? 'No answer. The customer has been told you tried to call.'
          : 'The call has ended.';
    showToast(message, { type: 'info' });
    cleanup();
  });

  const toggleMute = useCallback(() => {
    const track = streamRef.current?.getAudioTracks?.()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  }, []);

  /** Change microphone mid-call without dropping it. */
  const changeMicrophone = useCallback(
    async (deviceId) => {
      if (!deviceId || !pcRef.current) return;
      try {
        const next = await switchMicrophone({ pc: pcRef.current, oldStream: streamRef.current, deviceId, muted });
        streamRef.current = next;
        diagRef.current?.setStream(next);
        setMicId(deviceId);
      } catch {
        showToast('That microphone could not be used.', { type: 'error' });
      }
    },
    [muted, showToast],
  );

  const value = useMemo(
    () => ({ ringing, active, muted, answer, decline, callCustomer, hangUp, toggleMute, health, microphones, micId, changeMicrophone, me: admin?.id }),
    [ringing, active, muted, answer, decline, callCustomer, hangUp, toggleMute, health, microphones, micId, changeMicrophone, admin?.id],
  );

  return (
    <CallContext.Provider value={value}>
      {children}
      <audio ref={audioRef} autoPlay playsInline data-testid="call-remote-audio" style={{ display: 'none' }} />
    </CallContext.Provider>
  );
}

export function useCalls() {
  return (
    useContext(CallContext) || {
      ringing: [],
      active: null,
      muted: false,
      answer: () => {},
      decline: () => {},
      callCustomer: () => {},
      hangUp: () => {},
      toggleMute: () => {},
    }
  );
}
