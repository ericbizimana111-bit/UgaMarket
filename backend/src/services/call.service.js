const prisma = require('../config/db');
const env = require('../config/env');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');
const realtime = require('./realtime.service');
const notifications = require('./notification.service');

/**
 * Voice calls between customers and the store, in both directions:
 *   INBOUND   the customer calls; every staff console rings; first to answer wins
 *   OUTBOUND  a staff member calls a customer who has UgaMarket open
 *
 * Audio is WebRTC, peer-to-peer and always encrypted (DTLS-SRTP). The server
 * only relays the call set-up messages ("signals": SDP offer/answer and ICE
 * candidates) over the existing authenticated SSE stream, and it is the
 * authority on who may talk to whom:
 *
 *   customer  POST /api/calls                -> RINGING, every staff console rings
 *   staff     POST /api/admin/calls/:id/accept  first staff member wins -> ACTIVE
 *   customer  creates the offer; signals are relayed ONLY between the call's
 *             customer and the staff member who answered
 *   either    POST .../end                    -> ENDED
 *
 * Safety: sign-in required on both sides, one live call per customer, start
 * rate limit, ring timeout (-> MISSED + staff notification), maximum call
 * length, size/type validation of every signal, and a call log.
 */

const LIVE = ['RINGING', 'ACTIVE'];
const SIGNAL_TYPES = new Set(['offer', 'answer', 'ice']);
const MAX_SIGNAL_BYTES = 16 * 1024;
const MAX_CALLS_PER_10_MIN = 5;
const MAX_OUTBOUND_PER_10_MIN = 20;
const timers = new Map(); // callId -> timeout

/** Who placed the call: that side sends the WebRTC offer. */
const callerSide = (call) => (call.direction === 'OUTBOUND' ? 'ADMIN' : 'CUSTOMER');

function codedError(message, statusCode, code) {
  const err = new AppError(message, statusCode, [{ code, message }]);
  err.code = code;
  return err;
}

function iceServers() {
  const split = (v) =>
    String(v || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const servers = [];
  const stun = split(env.STUN_URLS);
  if (stun.length) servers.push({ urls: stun });
  const turn = split(env.TURN_URLS);
  if (turn.length) servers.push({ urls: turn, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
  return servers;
}

function callConfig() {
  return {
    iceServers: iceServers(),
    ringTimeoutSeconds: env.CALL_RING_TIMEOUT_SECONDS,
    maxMinutes: env.CALL_MAX_MINUTES,
  };
}

function formatCall(c) {
  return {
    id: c.id,
    direction: c.direction || 'INBOUND',
    status: c.status,
    endReason: c.endReason || null,
    endedBy: c.endedBy || null,
    createdAt: c.createdAt,
    answeredAt: c.answeredAt || null,
    endedAt: c.endedAt || null,
    durationSeconds: c.answeredAt && c.endedAt ? Math.max(0, Math.round((c.endedAt - c.answeredAt) / 1000)) : null,
    customer: c.user ? { id: c.user.id, fullName: c.user.fullName, phone: c.user.phone } : undefined,
    agent: c.admin ? { id: c.admin.id, fullName: c.admin.fullName } : null,
  };
}

function clearTimer(callId) {
  const t = timers.get(callId);
  if (t) clearTimeout(t);
  timers.delete(callId);
}

function schedule(callId, ms, fn) {
  clearTimer(callId);
  const t = setTimeout(() => {
    timers.delete(callId);
    fn().catch((error) => logger.warn(`[calls] timer for ${callId} failed: ${error.message}`));
  }, ms);
  t.unref?.();
  timers.set(callId, t);
}

function broadcastEnded(call) {
  const payload = { callId: call.id, direction: call.direction, status: call.status, reason: call.endReason || null, endedBy: call.endedBy || null };
  realtime.publish(`user:${call.userId}`, 'call:ended', payload);
  realtime.publish('admins', 'call:ended', payload);
}

/** Move a live call to a final state exactly once. Returns the row or null. */
async function finish(callId, { status, reason, endedBy, fromStatuses = LIVE }) {
  const result = await prisma.callSession.updateMany({
    where: { id: callId, status: { in: fromStatuses } },
    data: { status, endReason: reason, endedBy, endedAt: new Date() },
  });
  clearTimer(callId);
  if (result.count !== 1) return null;
  const call = await prisma.callSession.findUnique({
    where: { id: callId },
    include: { user: { select: { id: true, fullName: true, phone: true } }, admin: { select: { id: true, fullName: true } } },
  });
  broadcastEnded(call);
  if (status === 'MISSED' && call.direction === 'OUTBOUND') {
    // The customer missed OUR call: tell them so they can call back.
    await notifications.notifyCustomer(call.userId, {
      type: 'MISSED_CALL',
      title: 'Missed call from UgaMarket',
      message: `${call.admin?.fullName || 'Our team'} from UgaMarket tried to call you. Reply in Messages or call us back.`,
      linkUrl: '/account/messages',
    });
  } else if (status === 'MISSED') {
    await notifications.notifyAdmins({
      type: notifications.ADMIN_NOTIFICATION_TYPES.MISSED_CALL,
      title: `Missed call from ${call.user.fullName}`,
      message: `${call.user.fullName} (${call.user.phone}) tried to call. Call them back or reply in Messages.`,
      linkUrl: `/messages?customer=${call.userId}`,
      metadata: { callId: call.id, userId: call.userId },
    });
  }
  return call;
}

/** Calls left live by a restart or a lost connection are closed. */
async function sweepStale(userId = null) {
  const ringCutoff = new Date(Date.now() - env.CALL_RING_TIMEOUT_SECONDS * 1000 - 5000);
  const activeCutoff = new Date(Date.now() - env.CALL_MAX_MINUTES * 60 * 1000 - 5000);
  const stale = await prisma.callSession.findMany({
    where: {
      ...(userId && { userId }),
      OR: [
        { status: 'RINGING', createdAt: { lt: ringCutoff } },
        { status: 'ACTIVE', answeredAt: { lt: activeCutoff } },
      ],
    },
    select: { id: true, status: true },
    take: 100,
  });
  for (const c of stale) {
    await finish(c.id, { status: c.status === 'RINGING' ? 'MISSED' : 'ENDED', reason: 'TIMEOUT', endedBy: 'SYSTEM', fromStatuses: [c.status] });
  }
}

// ------------------------------------------------------------
// Customer
// ------------------------------------------------------------
async function startCall(userId) {
  await sweepStale(userId);

  const live = await prisma.callSession.findFirst({ where: { userId, status: { in: LIVE } }, select: { id: true } });
  if (live) throw codedError('You already have a call in progress.', 409, 'CALL_IN_PROGRESS');

  const recent = await prisma.callSession.count({ where: { userId, createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) } } });
  if (recent >= MAX_CALLS_PER_10_MIN) {
    throw codedError('Too many call attempts. Please wait a few minutes or send us a message.', 429, 'CALL_RATE_LIMITED');
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, fullName: true, phone: true } });
  const call = await prisma.callSession.create({ data: { userId }, include: { user: { select: { id: true, fullName: true, phone: true } } } });

  // Nobody on duty: log a missed call so staff can call back.
  if (realtime.subscriberCount('admins') === 0) {
    await finish(call.id, { status: 'MISSED', reason: 'NO_AGENT_ONLINE', endedBy: 'SYSTEM' });
    throw codedError(
      'Our support team is not online right now. We have logged your call and will get back to you — you can also leave a message.',
      503,
      'NO_AGENT_ONLINE'
    );
  }

  realtime.publish('admins', 'call:incoming', {
    callId: call.id,
    customer: { id: user.id, fullName: user.fullName, phone: user.phone },
    createdAt: call.createdAt,
    ringTimeoutSeconds: env.CALL_RING_TIMEOUT_SECONDS,
  });
  schedule(call.id, env.CALL_RING_TIMEOUT_SECONDS * 1000, () =>
    finish(call.id, { status: 'MISSED', reason: 'NO_ANSWER', endedBy: 'SYSTEM', fromStatuses: ['RINGING'] })
  );
  return formatCall(call);
}

// ------------------------------------------------------------
// Staff
// ------------------------------------------------------------
async function acceptCall(admin, callId) {
  const result = await prisma.callSession.updateMany({
    where: { id: callId, status: 'RINGING', direction: 'INBOUND' },
    data: { status: 'ACTIVE', adminId: admin.id, answeredAt: new Date() },
  });
  if (result.count !== 1) throw codedError('This call was already answered or has ended.', 409, 'CALL_UNAVAILABLE');

  const call = await prisma.callSession.findUnique({
    where: { id: callId },
    include: { user: { select: { id: true, fullName: true, phone: true } }, admin: { select: { id: true, fullName: true } } },
  });
  realtime.publish(`user:${call.userId}`, 'call:accepted', { callId, agentName: admin.fullName });
  realtime.publish('admins', 'call:taken', { callId, adminId: admin.id, adminName: admin.fullName });
  schedule(callId, env.CALL_MAX_MINUTES * 60 * 1000, () => finish(callId, { status: 'ENDED', reason: 'MAX_DURATION', endedBy: 'SYSTEM', fromStatuses: ['ACTIVE'] }));
  return formatCall(call);
}

async function rejectCall(admin, callId) {
  const target = await prisma.callSession.findUnique({ where: { id: callId }, select: { direction: true } });
  if (!target || target.direction !== 'INBOUND') throw codedError('This call was already answered or has ended.', 409, 'CALL_UNAVAILABLE');
  const call = await finish(callId, { status: 'REJECTED', reason: 'DECLINED', endedBy: 'ADMIN', fromStatuses: ['RINGING'] });
  if (!call) throw codedError('This call was already answered or has ended.', 409, 'CALL_UNAVAILABLE');
  return formatCall(call);
}

/** Staff call a customer. The customer must have UgaMarket open to ring. */
async function startOutboundCall(admin, userId) {
  await sweepStale(userId);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, fullName: true, phone: true, isActive: true } });
  if (!user || !user.isActive) throw new AppError('Customer not found', 404);

  const [customerBusy, agentBusy, recent] = await Promise.all([
    prisma.callSession.findFirst({ where: { userId, status: { in: LIVE } }, select: { id: true } }),
    prisma.callSession.findFirst({ where: { adminId: admin.id, status: { in: LIVE } }, select: { id: true } }),
    prisma.callSession.count({ where: { adminId: admin.id, direction: 'OUTBOUND', createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) } } }),
  ]);
  if (customerBusy) throw codedError('This customer is already on a call.', 409, 'CUSTOMER_BUSY');
  if (agentBusy) throw codedError('Finish your current call first.', 409, 'AGENT_BUSY');
  if (recent >= MAX_OUTBOUND_PER_10_MIN) throw codedError('Too many calls in a short time. Please wait a few minutes.', 429, 'CALL_RATE_LIMITED');

  const call = await prisma.callSession.create({
    data: { userId, adminId: admin.id, direction: 'OUTBOUND' },
    include: { user: { select: { id: true, fullName: true, phone: true } }, admin: { select: { id: true, fullName: true } } },
  });

  if (realtime.subscriberCount(`user:${userId}`) === 0) {
    await finish(call.id, { status: 'MISSED', reason: 'CUSTOMER_OFFLINE', endedBy: 'SYSTEM' });
    throw codedError(
      `${user.fullName} does not have UgaMarket open right now, so the call cannot ring. They have been told you tried to call — send them a message or phone ${user.phone}.`,
      409,
      'CUSTOMER_OFFLINE'
    );
  }

  realtime.publish(`user:${userId}`, 'call:incoming', {
    callId: call.id,
    agentName: admin.fullName,
    ringTimeoutSeconds: env.CALL_RING_TIMEOUT_SECONDS,
  });
  schedule(call.id, env.CALL_RING_TIMEOUT_SECONDS * 1000, () =>
    finish(call.id, { status: 'MISSED', reason: 'NO_ANSWER', endedBy: 'SYSTEM', fromStatuses: ['RINGING'] })
  );
  return formatCall(call);
}

/** The customer answers a staff call. */
async function acceptOutboundCall(userId, callId) {
  const result = await prisma.callSession.updateMany({
    where: { id: callId, userId, status: 'RINGING', direction: 'OUTBOUND' },
    data: { status: 'ACTIVE', answeredAt: new Date() },
  });
  if (result.count !== 1) throw codedError('This call has already ended.', 409, 'CALL_UNAVAILABLE');
  const call = await prisma.callSession.findUnique({
    where: { id: callId },
    include: { user: { select: { id: true, fullName: true, phone: true } }, admin: { select: { id: true, fullName: true } } },
  });
  realtime.publish(`admin:${call.adminId}`, 'call:accepted', { callId, customerName: call.user.fullName });
  schedule(callId, env.CALL_MAX_MINUTES * 60 * 1000, () => finish(callId, { status: 'ENDED', reason: 'MAX_DURATION', endedBy: 'SYSTEM', fromStatuses: ['ACTIVE'] }));
  return formatCall(call);
}

/** The customer declines a staff call. */
async function rejectOutboundCall(userId, callId) {
  const target = await prisma.callSession.findUnique({ where: { id: callId }, select: { userId: true, direction: true } });
  if (!target || target.userId !== userId || target.direction !== 'OUTBOUND') throw new AppError('Call not found', 404);
  const call = await finish(callId, { status: 'REJECTED', reason: 'DECLINED', endedBy: 'CUSTOMER', fromStatuses: ['RINGING'] });
  if (!call) throw codedError('This call has already ended.', 409, 'CALL_UNAVAILABLE');
  return formatCall(call);
}

// ------------------------------------------------------------
// Both sides
// ------------------------------------------------------------

/** party: { kind: 'CUSTOMER'|'ADMIN', id } */
async function loadForParty(party, callId) {
  const call = await prisma.callSession.findUnique({ where: { id: callId } });
  const allowed =
    call &&
    (party.kind === 'CUSTOMER'
      ? call.userId === party.id
      : call.adminId === party.id || (call.status === 'RINGING' && call.direction === 'INBOUND'));
  if (!allowed) throw new AppError('Call not found', 404);
  return call;
}

async function relaySignal(party, callId, { type, data }) {
  if (!SIGNAL_TYPES.has(type)) throw new AppError('Invalid signal type', 400);
  const size = Buffer.byteLength(JSON.stringify(data ?? null));
  if (size > MAX_SIGNAL_BYTES) throw new AppError('Signal too large', 413);

  const call = await loadForParty(party, callId);
  if (call.status !== 'ACTIVE') throw codedError('This call is not active.', 409, 'CALL_NOT_ACTIVE');
  // Whoever placed the call makes the offer; the other side answers. ICE flows both ways.
  const caller = callerSide(call);
  if ((type === 'offer' && party.kind !== caller) || (type === 'answer' && party.kind === caller)) {
    throw new AppError('Unexpected signal for this side of the call', 400);
  }
  const to = party.kind === 'CUSTOMER' ? `admin:${call.adminId}` : `user:${call.userId}`;
  realtime.publish(to, 'call:signal', { callId, type, data });
  return { relayed: true };
}

async function endCall(party, callId, reason = 'HANGUP') {
  const call = await loadForParty(party, callId);
  if (!LIVE.includes(call.status)) return formatCall(call); // already over: idempotent
  // Hanging up while it rings: the caller cancelling is a missed call for
  // the other side; the callee hanging up is a decline.
  const isCaller = party.kind === callerSide(call);
  const status = call.status === 'RINGING' ? (isCaller ? 'MISSED' : 'REJECTED') : 'ENDED';
  const cleanReason = /^[A-Z_]{2,40}$/.test(String(reason)) ? String(reason) : 'HANGUP';
  const ended = await finish(callId, {
    status,
    reason: call.status === 'RINGING' && isCaller ? `CANCELLED_BY_${party.kind}` : cleanReason,
    endedBy: party.kind,
  });
  return formatCall(ended || call);
}

// ------------------------------------------------------------
// Lost connections
// ------------------------------------------------------------
// If a participant's browser closes, crashes or loses the network, their
// realtime stream drops. Give them a short grace period to reconnect (page
// reload, brief signal loss), then end their live calls so nobody stays
// "busy" on a dead call.
const DISCONNECT_GRACE_MS = 20 * 1000;
const graceTimers = new Map(); // channel -> timeout

function handleChannelEmpty(channel, graceMs = DISCONNECT_GRACE_MS) {
  const match = /^(user|admin):(.+)$/.exec(channel);
  if (!match) return null;
  clearTimeout(graceTimers.get(channel));
  return new Promise((resolve) => {
    const timer = setTimeout(async () => {
      graceTimers.delete(channel);
      if (realtime.subscriberCount(channel) > 0) return resolve(0); // they came back
      let closed = 0;
      try {
        const where = match[1] === 'user' ? { userId: match[2] } : { adminId: match[2] };
        const live = await prisma.callSession.findMany({ where: { ...where, status: { in: LIVE } }, select: { id: true, status: true } });
        for (const c of live) {
          const done = await finish(c.id, {
            status: c.status === 'RINGING' ? 'MISSED' : 'ENDED',
            reason: 'CONNECTION_LOST',
            endedBy: match[1] === 'user' ? 'CUSTOMER' : 'ADMIN',
            fromStatuses: [c.status],
          });
          if (done) closed += 1;
        }
      } catch (error) {
        logger.warn(`[calls] could not close calls for ${channel}: ${error.message}`);
      }
      resolve(closed);
    }, graceMs);
    timer.unref?.();
    graceTimers.set(channel, timer);
  });
}

realtime.onChannelEmpty((channel) => {
  handleChannelEmpty(channel);
});

/**
 * Server start: call signalling lives in this process, so any call still
 * marked live was cut off by the restart.
 */
async function closeCallsInterruptedByRestart() {
  const result = await prisma.callSession.updateMany({
    where: { status: { in: LIVE } },
    data: { status: 'ENDED', endReason: 'SERVER_RESTART', endedBy: 'SYSTEM', endedAt: new Date() },
  });
  return result.count;
}

async function listCalls({ limit = 30 } = {}) {
  const take = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const rows = await prisma.callSession.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    include: { user: { select: { id: true, fullName: true, phone: true } }, admin: { select: { id: true, fullName: true } } },
  });
  return rows.map(formatCall);
}

module.exports = {
  callConfig,
  startCall,
  acceptCall,
  rejectCall,
  startOutboundCall,
  acceptOutboundCall,
  rejectOutboundCall,
  relaySignal,
  endCall,
  listCalls,
  sweepStale,
  closeCallsInterruptedByRestart,
  handleChannelEmpty,
  MAX_SIGNAL_BYTES,
};
