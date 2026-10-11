import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import api from '../services/api';
import { useAuth } from './AuthContext';
import { useRealtimeEvent } from './RealtimeContext';
import { useToast } from '../components/feedback/Toast';
import { startRingtone } from '../utils/sounds';

/**
 * Staff side of customer voice calls (WebRTC audio).
 *
 *  call:incoming  -> every signed-in console rings (ringtone + desktop alert)
 *  Answer         -> microphone permission, POST /admin/calls/:id/accept
 *                    (the first staff member to answer wins; the others'
 *                    consoles stop ringing on call:taken)
 *  The customer sends the offer; we answer; ICE candidates flow both ways
 *  through the API, which only relays between the two call participants.
 */
const CallContext = createContext(null);

const AUDIO = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false };

export function CallProvider({ children }) {
  const { admin, isAuthenticated } = useAuth();
  const { showToast } = useToast();
  const [ringing, setRinging] = useState([]); // [{ callId, customer, createdAt }]
  const [active, setActive] = useState(null); // { callId, customer, state: 'connecting'|'connected', since }
  const [muted, setMuted] = useState(false);

  const pcRef = useRef(null);
  const streamRef = useRef(null);
  const callIdRef = useRef(null);
  const pendingIce = useRef([]);
  const remoteSet = useRef(false);
  const audioRef = useRef(null);
  const stopRing = useRef(null);

  // Ringtone plays while anything is ringing and we are not already on a call.
  useEffect(() => {
    if (ringing.length > 0 && !active) {
      if (!stopRing.current) stopRing.current = startRingtone();
    } else if (stopRing.current) {
      stopRing.current();
      stopRing.current = null;
    }
  }, [ringing.length, active]);

  useEffect(() => () => stopRing.current?.(), []);

  /** Stop the microphone and close the connection (no state updates). */
  const releaseMedia = useCallback(() => {
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
    if (audioRef.current) audioRef.current.srcObject = null;
  }, []);

  const cleanup = useCallback(() => {
    releaseMedia();
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

  useRealtimeEvent('call:incoming', (data) => {
    if (!data?.callId) return;
    setRinging((prev) => (prev.some((c) => c.callId === data.callId) ? prev : [...prev, data]));
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState === 'hidden') {
      try {
        const n = new Notification(`Incoming call: ${data.customer?.fullName || 'Customer'}`, { body: 'Open the console to answer.', tag: data.callId, icon: '/logo.png', requireInteraction: true });
        n.onclick = () => window.focus();
      } catch {
        /* needs a service worker on some browsers */
      }
    }
  });

  useRealtimeEvent('call:taken', (data) => {
    if (!data) return;
    setRinging((prev) => prev.filter((c) => c.callId !== data.callId));
  });

  useRealtimeEvent('call:ended', (data) => {
    if (!data) return;
    setRinging((prev) => prev.filter((c) => c.callId !== data.callId));
    if (data.callId === callIdRef.current) {
      showToast('The call has ended.', { type: 'info' });
      cleanup();
    }
  });

  useRealtimeEvent('call:signal', async (data) => {
    const pc = pcRef.current;
    if (!data || data.callId !== callIdRef.current || !pc) return;
    try {
      if (data.type === 'offer') {
        await pc.setRemoteDescription(data.data);
        remoteSet.current = true;
        for (const c of pendingIce.current) await pc.addIceCandidate(c).catch(() => {});
        pendingIce.current = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await signal('answer', { type: answer.type, sdp: answer.sdp });
      } else if (data.type === 'ice' && data.data) {
        if (remoteSet.current) await pc.addIceCandidate(data.data).catch(() => {});
        else pendingIce.current.push(data.data);
      }
    } catch {
      /* one bad signal must not drop the call */
    }
  });

  const answer = useCallback(
    async (call) => {
      if (active) return;
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof window.RTCPeerConnection === 'undefined') {
        showToast('This browser cannot take calls. Use an up-to-date Chrome, Edge, Firefox or Safari over https.', { type: 'error' });
        return;
      }
      try {
        streamRef.current = await navigator.mediaDevices.getUserMedia(AUDIO);
      } catch {
        showToast('Microphone access is blocked. Allow the microphone for this site and try again.', { type: 'error' });
        return;
      }

      // The peer connection must exist before the customer's offer arrives.
      callIdRef.current = call.callId;
      try {
        const config = (await api.get('/admin/calls/config'))?.data || {};
        const pc = new RTCPeerConnection({ iceServers: config.iceServers || [] });
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
          if (pc.connectionState === 'connected') setActive((a) => (a ? { ...a, state: 'connected', since: Date.now() } : a));
          if (pc.connectionState === 'failed') {
            showToast('The call connection failed.', { type: 'error' });
            api.post(`/admin/calls/${call.callId}/end`, { reason: 'CONNECTION_FAILED' }).catch(() => {});
            cleanup();
          }
        };
        setActive({ callId: call.callId, customer: call.customer, state: 'connecting', since: null });
        setRinging((prev) => prev.filter((c) => c.callId !== call.callId));
        await api.post(`/admin/calls/${call.callId}/accept`);
      } catch (err) {
        showToast(err?.message || 'Could not answer the call.', { type: 'error' });
        setRinging((prev) => prev.filter((c) => c.callId !== call.callId));
        cleanup();
      }
    },
    [active, cleanup, showToast, signal],
  );

  const decline = useCallback(
    async (call) => {
      setRinging((prev) => prev.filter((c) => c.callId !== call.callId));
      try {
        await api.post(`/admin/calls/${call.callId}/reject`);
      } catch {
        /* already answered elsewhere or ended */
      }
    },
    [],
  );

  const hangUp = useCallback(() => {
    const id = callIdRef.current;
    if (id) api.post(`/admin/calls/${id}/end`, { reason: 'HANGUP' }).catch(() => {});
    cleanup();
  }, [cleanup]);

  const toggleMute = useCallback(() => {
    const track = streamRef.current?.getAudioTracks?.()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  }, []);

  const value = useMemo(
    () => ({ ringing, active, muted, answer, decline, hangUp, toggleMute, me: admin?.id }),
    [ringing, active, muted, answer, decline, hangUp, toggleMute, admin?.id],
  );

  return (
    <CallContext.Provider value={value}>
      {children}
      <audio ref={audioRef} autoPlay playsInline hidden />
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
      hangUp: () => {},
      toggleMute: () => {},
    }
  );
}
