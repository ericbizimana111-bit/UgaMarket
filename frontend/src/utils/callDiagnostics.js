/**
 * Live call health, so problems are visible instead of mysterious:
 *   micLevel       0..1  how loud MY microphone is (am I being picked up?)
 *   remoteLevel    0..1  how loud the OTHER person's audio arriving here is
 *   remoteSilent   true when nothing has arrived from the other side for a while
 *   micSilent      true when my microphone has picked up nothing for a while
 *   quality        'good' | 'fair' | 'poor'  (packet loss, round-trip time)
 *
 * Kept identical in frontend/src/utils and admin/src/utils.
 */

const SILENT_LEVEL = 0.01;
const SILENT_AFTER_MS = 8000;

export function startCallDiagnostics({ pc, stream, onUpdate }) {
  let stopped = false;
  let ctx = null;
  let analyser = null;
  let source = null;
  const buf = new Float32Array(1024);
  let lastMicSound = Date.now();
  let lastRemoteSound = Date.now();
  let prev = null; // previous inbound stats for loss deltas
  const state = { micLevel: 0, remoteLevel: 0, micSilent: false, remoteSilent: false, quality: 'good', lossPct: 0, rttMs: null };

  const attachMic = (s) => {
    try {
      source?.disconnect();
      const track = s?.getAudioTracks?.()[0];
      if (!track) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!ctx) ctx = new Ctx();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source = ctx.createMediaStreamSource(new MediaStream([track]));
      source.connect(analyser);
    } catch {
      analyser = null;
    }
  };
  attachMic(stream);

  const micTimer = setInterval(() => {
    if (stopped || !analyser) return;
    analyser.getFloatTimeDomainData(buf);
    const rms = Math.sqrt(buf.reduce((a, x) => a + x * x, 0) / buf.length);
    const level = Math.min(1, rms * 4);
    const track = stream?.getAudioTracks?.()[0];
    const muted = track && !track.enabled;
    if (level > SILENT_LEVEL || muted) lastMicSound = Date.now();
    state.micLevel = muted ? 0 : level;
    state.micSilent = Date.now() - lastMicSound > SILENT_AFTER_MS;
    onUpdate({ ...state });
  }, 200);

  const statsTimer = setInterval(async () => {
    if (stopped || !pc || pc.connectionState === 'closed') return;
    try {
      const report = await pc.getStats();
      let inbound = null;
      let pair = null;
      report.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') inbound = r;
        if (r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded') pair = r;
      });
      if (inbound) {
        const level = typeof inbound.audioLevel === 'number' ? inbound.audioLevel : 0;
        state.remoteLevel = Math.min(1, level * 3);
        if (level > SILENT_LEVEL) lastRemoteSound = Date.now();
        state.remoteSilent = Date.now() - lastRemoteSound > SILENT_AFTER_MS;
        if (prev) {
          const received = (inbound.packetsReceived || 0) - (prev.packetsReceived || 0);
          const lost = (inbound.packetsLost || 0) - (prev.packetsLost || 0);
          state.lossPct = received + lost > 0 ? Math.max(0, Math.round((lost / (received + lost)) * 100)) : 0;
        }
        prev = inbound;
      }
      state.rttMs = pair && typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null;
      state.quality = state.lossPct > 8 || (state.rttMs || 0) > 700 ? 'poor' : state.lossPct > 3 || (state.rttMs || 0) > 350 ? 'fair' : 'good';
      onUpdate({ ...state });
    } catch {
      /* stats are best effort */
    }
  }, 1500);

  return {
    /** Point the mic meter at a new microphone stream (after switching devices). */
    setStream(next) {
      stream = next;
      lastMicSound = Date.now();
      attachMic(next);
    },
    stop() {
      stopped = true;
      clearInterval(micTimer);
      clearInterval(statsTimer);
      try {
        source?.disconnect();
        ctx?.close();
      } catch {
        /* closed */
      }
    }
  };
}

/** Microphones the browser can use (labels appear once permission is granted). */
export async function listMicrophones() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  } catch {
    return [];
  }
}

/** Swap the microphone mid-call without dropping the call. Returns the new stream. */
export async function switchMicrophone({ pc, oldStream, deviceId, muted }) {
  const next = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false
  });
  const track = next.getAudioTracks()[0];
  track.enabled = !muted;
  const sender = pc?.getSenders?.().find((s) => s.track && s.track.kind === 'audio');
  if (sender) await sender.replaceTrack(track);
  oldStream?.getTracks().forEach((t) => t.stop());
  return next;
}

/**
 * Voice-friendly sending: high network priority and a speech bitrate that
 * survives weak mobile uplinks (Opus keeps its built-in loss recovery).
 */
export async function tuneAudioSender(pc) {
  try {
    const sender = pc?.getSenders?.().find((s) => s.track && s.track.kind === 'audio');
    if (!sender?.getParameters) return;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) return;
    params.encodings[0].maxBitrate = 32000;
    params.encodings[0].priority = 'high';
    params.encodings[0].networkPriority = 'high';
    await sender.setParameters(params);
  } catch {
    /* not supported on this browser: defaults are fine */
  }
}
