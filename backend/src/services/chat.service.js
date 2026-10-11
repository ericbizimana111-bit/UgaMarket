const prisma = require('../config/db');
const { AppError } = require('../middleware/errorHandler');
const realtime = require('./realtime.service');
const notifications = require('./notification.service');

/**
 * Customer <-> UgaMarket support chat.
 * One conversation per customer. A message may reference one of the
 * customer's orders or service bookings so staff see the context.
 * Unread counters are maintained in the same transaction as each message.
 */

const MAX_BODY = 2000;
const MESSAGE_INCLUDE = {
  senderAdmin: { select: { id: true, fullName: true } },
  order: { select: { id: true, orderNumber: true } },
  serviceRequest: { select: { id: true, requestNumber: true } },
};

function cleanBody(body) {
  const text = String(body || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (!text) throw new AppError('Message cannot be empty', 400);
  if (text.length > MAX_BODY) throw new AppError(`Message is too long (max ${MAX_BODY} characters)`, 400);
  return text;
}

function formatMessage(m) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderType: m.senderType,
    senderName: m.senderType === 'ADMIN' ? (m.senderAdmin ? m.senderAdmin.fullName : 'UgaMarket') : null,
    body: m.body,
    order: m.order ? { id: m.order.id, orderNumber: m.order.orderNumber } : null,
    serviceRequest: m.serviceRequest ? { id: m.serviceRequest.id, requestNumber: m.serviceRequest.requestNumber } : null,
    // Receipts (sent = row exists; delivered = reached a recipient device;
    // read = recipient opened the conversation).
    deliveredAt: m.deliveredAt || null,
    readAt: m.readAt || null,
    createdAt: m.createdAt,
  };
}

function formatConversation(c) {
  return {
    id: c.id,
    lastMessage: c.lastMessage,
    lastMessageAt: c.lastMessageAt,
    customerUnread: c.customerUnread,
    adminUnread: c.adminUnread,
    createdAt: c.createdAt,
    customer: c.user ? { id: c.user.id, fullName: c.user.fullName, phone: c.user.phone, email: c.user.email || null } : undefined,
  };
}

async function getOrCreateConversation(userId, client = prisma) {
  const existing = await client.conversation.findUnique({ where: { userId } });
  if (existing) return existing;
  try {
    return await client.conversation.create({ data: { userId } });
  } catch (error) {
    if (error.code === 'P2002') return client.conversation.findUnique({ where: { userId } }); // concurrent create
    throw error;
  }
}

async function listMessages(conversationId, { before = null, limit = 50 } = {}) {
  const take = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const where = { conversationId };
  if (before) {
    const d = new Date(before);
    if (!Number.isNaN(d.getTime())) where.createdAt = { lt: d };
  }
  const rows = await prisma.chatMessage.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: take + 1,
    include: MESSAGE_INCLUDE,
  });
  const hasMore = rows.length > take;
  return { messages: rows.slice(0, take).reverse().map(formatMessage), hasMore };
}

/** Verify optional order/service references belong to the conversation's customer. */
async function resolveReferences(userId, { orderId = null, serviceRequestId = null }) {
  if (orderId) {
    const order = await prisma.order.findFirst({ where: { id: orderId, userId }, select: { id: true } });
    if (!order) throw new AppError('Order not found', 404);
  }
  if (serviceRequestId) {
    const sr = await prisma.serviceRequest.findFirst({ where: { id: serviceRequestId, userId }, select: { id: true } });
    if (!sr) throw new AppError('Service booking not found', 404);
  }
  return { orderId: orderId || null, serviceRequestId: serviceRequestId || null };
}

function preview(text) {
  return text.length > 280 ? `${text.slice(0, 277)}...` : text;
}

// ------------------------------------------------------------
// Customer side
// ------------------------------------------------------------
async function getCustomerThread(userId, opts = {}) {
  const conversation = await getOrCreateConversation(userId);
  await markDeliveredToCustomer(userId);
  const page = await listMessages(conversation.id, opts);
  return { conversation: formatConversation(conversation), ...page };
}

async function sendCustomerMessage(userId, { body, orderId = null, serviceRequestId = null }) {
  const text = cleanBody(body);
  const refs = await resolveReferences(userId, { orderId, serviceRequestId });
  const conversation = await getOrCreateConversation(userId);

  const { message, wasUnread, convo } = await prisma.$transaction(async (tx) => {
    const before = await tx.conversation.findUnique({ where: { id: conversation.id }, select: { adminUnread: true } });
    const created = await tx.chatMessage.create({
      data: {
        conversationId: conversation.id,
        senderType: 'CUSTOMER',
        body: text,
        ...refs,
        deliveredAt: realtime.subscriberCount('admins') > 0 ? new Date() : null,
      },
      include: MESSAGE_INCLUDE,
    });
    const updated = await tx.conversation.update({
      where: { id: conversation.id },
      data: { lastMessage: preview(text), lastMessageAt: created.createdAt, adminUnread: { increment: 1 } },
      include: { user: { select: { id: true, fullName: true, phone: true, email: true } } },
    });
    return { message: created, wasUnread: before.adminUnread > 0, convo: updated };
  });

  const payload = { message: formatMessage(message), conversation: formatConversation(convo) };
  realtime.publish('admins', 'chat:message', payload);
  realtime.publish(`user:${userId}`, 'chat:message', payload);

  // One feed notification per unread burst (the inbox shows every message).
  if (!wasUnread) {
    const ref = message.order ? ` about order ${message.order.orderNumber}` : message.serviceRequest ? ` about booking ${message.serviceRequest.requestNumber}` : '';
    await notifications.notifyAdmins({
      type: notifications.ADMIN_NOTIFICATION_TYPES.NEW_MESSAGE,
      title: `New message from ${convo.user.fullName}`,
      message: `${convo.user.fullName}${ref}: ${preview(text).slice(0, 200)}`,
      linkUrl: `/messages?c=${conversation.id}`,
      orderId: refs.orderId,
      metadata: { conversationId: conversation.id },
    });
  }
  return payload.message;
}

/**
 * Stamp receipts on the messages one side has received/read. Returns the
 * timestamp when anything changed (null otherwise).
 */
async function stampReceipts(conversationId, fromSender, { read }) {
  const now = new Date();
  const delivered = await prisma.chatMessage.updateMany({
    where: { conversationId, senderType: fromSender, deliveredAt: null },
    data: { deliveredAt: now },
  });
  let readCount = 0;
  if (read) {
    const r = await prisma.chatMessage.updateMany({
      where: { conversationId, senderType: fromSender, readAt: null },
      data: { readAt: now },
    });
    readCount = r.count;
  }
  return delivered.count > 0 || readCount > 0 ? now : null;
}

async function markCustomerRead(userId) {
  const conversation = await getOrCreateConversation(userId);
  await prisma.conversation.update({ where: { id: conversation.id }, data: { customerUnread: 0 } });
  // Reading the chat also reads the "new message" notifications about it.
  await prisma.notification.updateMany({ where: { userId, type: 'NEW_MESSAGE', isRead: false }, data: { isRead: true } });
  const at = (await stampReceipts(conversation.id, 'ADMIN', { read: true })) || new Date();
  const payload = { conversationId: conversation.id, by: 'CUSTOMER', readAt: at.toISOString() };
  realtime.publish('admins', 'chat:read', payload);
  realtime.publish(`user:${userId}`, 'chat:read', payload);
  return { customerUnread: 0 };
}

/**
 * A recipient came online (opened the stream or the inbox): everything sent
 * to them so far is now delivered. Senders are told so their ticks update.
 */
async function markDeliveredToCustomer(userId) {
  const conversation = await prisma.conversation.findUnique({ where: { userId }, select: { id: true } });
  if (!conversation) return;
  const at = await stampReceipts(conversation.id, 'ADMIN', { read: false });
  if (at) realtime.publish('admins', 'chat:delivered', { conversationId: conversation.id, by: 'CUSTOMER', deliveredAt: at.toISOString() });
}

async function markDeliveredToAdmins() {
  const pending = await prisma.chatMessage.findMany({
    where: { senderType: 'CUSTOMER', deliveredAt: null },
    select: { conversationId: true, conversation: { select: { userId: true } } },
    distinct: ['conversationId'],
    take: 500,
  });
  if (!pending.length) return;
  const now = new Date();
  await prisma.chatMessage.updateMany({
    where: { senderType: 'CUSTOMER', deliveredAt: null, conversationId: { in: pending.map((p) => p.conversationId) } },
    data: { deliveredAt: now },
  });
  for (const p of pending) {
    const payload = { conversationId: p.conversationId, by: 'ADMIN', deliveredAt: now.toISOString() };
    realtime.publish(`user:${p.conversation.userId}`, 'chat:delivered', payload);
    realtime.publish('admins', 'chat:delivered', payload);
  }
}

async function customerUnreadCount(userId) {
  const c = await prisma.conversation.findUnique({ where: { userId }, select: { customerUnread: true } });
  return c ? c.customerUnread : 0;
}

// ------------------------------------------------------------
// Staff side
// ------------------------------------------------------------
async function listConversations({ page = 1, limit = 30, search = null, unreadOnly = false } = {}) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const where = { lastMessageAt: { not: null } };
  if (unreadOnly) where.adminUnread = { gt: 0 };
  if (search && String(search).trim()) {
    const q = String(search).trim().slice(0, 100);
    where.user = {
      OR: [
        { fullName: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { email: { contains: q, mode: 'insensitive' } },
      ],
    };
  }
  const [total, rows, unreadTotal] = await Promise.all([
    prisma.conversation.count({ where }),
    prisma.conversation.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
      include: { user: { select: { id: true, fullName: true, phone: true, email: true } } },
    }),
    prisma.conversation.aggregate({ _sum: { adminUnread: true } }),
  ]);
  return {
    items: rows.map(formatConversation),
    unreadTotal: unreadTotal._sum.adminUnread || 0,
    pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
  };
}

async function getConversationForAdmin(conversationId, opts = {}) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { user: { select: { id: true, fullName: true, phone: true, email: true, createdAt: true } } },
  });
  if (!conversation) throw new AppError('Conversation not found', 404);

  const [page, recentOrders, recentBookings] = await Promise.all([
    listMessages(conversationId, opts),
    prisma.order.findMany({
      where: { userId: conversation.userId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, orderNumber: true, status: true, totalAmount: true, createdAt: true },
    }),
    prisma.serviceRequest.findMany({
      where: { userId: conversation.userId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, requestNumber: true, status: true, createdAt: true, service: { select: { nameEn: true } } },
    }),
  ]);
  return {
    conversation: formatConversation(conversation),
    ...page,
    // Whether the customer has UgaMarket open (an in-app call can ring).
    customerOnline: realtime.subscriberCount(`user:${conversation.userId}`) > 0,
    context: {
      recentOrders,
      recentBookings: recentBookings.map((b) => ({ ...b, serviceName: b.service.nameEn, service: undefined })),
    },
  };
}

/** Staff opens (or creates) the thread with a given customer. */
async function openConversationWithCustomer(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new AppError('Customer not found', 404);
  const conversation = await getOrCreateConversation(userId);
  return { id: conversation.id };
}

async function sendAdminMessage(admin, conversationId, { body, orderId = null, serviceRequestId = null }) {
  const text = cleanBody(body);
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation) throw new AppError('Conversation not found', 404);
  const refs = await resolveReferences(conversation.userId, { orderId, serviceRequestId });

  const { message, wasUnread, convo } = await prisma.$transaction(async (tx) => {
    const before = await tx.conversation.findUnique({ where: { id: conversationId }, select: { customerUnread: true } });
    const created = await tx.chatMessage.create({
      data: {
        conversationId,
        senderType: 'ADMIN',
        senderAdminId: admin.id,
        body: text,
        ...refs,
        deliveredAt: realtime.subscriberCount(`user:${conversation.userId}`) > 0 ? new Date() : null,
      },
      include: MESSAGE_INCLUDE,
    });
    const updated = await tx.conversation.update({
      where: { id: conversationId },
      // Replying implies staff has read the thread.
      data: { lastMessage: preview(text), lastMessageAt: created.createdAt, customerUnread: { increment: 1 }, adminUnread: 0 },
      include: { user: { select: { id: true, fullName: true, phone: true, email: true } } },
    });
    return { message: created, wasUnread: before.customerUnread > 0, convo: updated };
  });

  const payload = { message: formatMessage(message), conversation: formatConversation(convo) };
  realtime.publish(`user:${conversation.userId}`, 'chat:message', payload);
  realtime.publish('admins', 'chat:message', payload);
  // Replying means staff have read the customer's messages.
  const readAt = await stampReceipts(conversationId, 'CUSTOMER', { read: true });
  if (readAt) {
    const readPayload = { conversationId, by: 'ADMIN', readAt: readAt.toISOString() };
    realtime.publish(`user:${conversation.userId}`, 'chat:read', readPayload);
    realtime.publish('admins', 'chat:read', readPayload);
  }

  if (!wasUnread) {
    await notifications.notifyCustomer(conversation.userId, {
      type: 'NEW_MESSAGE',
      title: 'New message from UgaMarket',
      message: preview(text).slice(0, 200),
      linkUrl: '/account/messages',
    });
  }
  return payload.message;
}

async function markAdminRead(conversationId) {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true, userId: true } });
  if (!conversation) throw new AppError('Conversation not found', 404);
  await prisma.conversation.update({ where: { id: conversationId }, data: { adminUnread: 0 } });
  const at = (await stampReceipts(conversationId, 'CUSTOMER', { read: true })) || new Date();
  const payload = { conversationId, by: 'ADMIN', readAt: at.toISOString() };
  realtime.publish('admins', 'chat:read', payload);
  realtime.publish(`user:${conversation.userId}`, 'chat:read', payload);
  return { adminUnread: 0 };
}

module.exports = {
  MAX_BODY,
  markDeliveredToCustomer,
  markDeliveredToAdmins,
  getCustomerThread,
  sendCustomerMessage,
  markCustomerRead,
  customerUnreadCount,
  listConversations,
  getConversationForAdmin,
  openConversationWithCustomer,
  sendAdminMessage,
  markAdminRead,
};
