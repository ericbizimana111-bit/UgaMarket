const prisma = require('../config/db');
const { AppError } = require('../middleware/errorHandler');
const { normalizeLanguage } = require('../utils/translation');
const { normalizeUgandaPhone } = require('../utils/phone');
const translator = require('./translator.service');

/**
 * Storefront content the owner controls from the admin console:
 *  - store profile: public contact details + optional top-bar announcement
 *  - FAQs shown on the help page
 * Admins write English only; other languages are machine-translated in the
 * background (hand-written translations seeded for the original FAQs).
 */

const STORE_ID = 1;

async function getStoreRow() {
  // The row is created by the migration; upsert keeps fresh databases working.
  return prisma.storeProfile.upsert({ where: { id: STORE_ID }, update: {}, create: { id: STORE_ID } });
}

function formatStore(row) {
  return {
    storeName: row.storeName,
    supportPhone: row.supportPhone || null,
    supportEmail: row.supportEmail || null,
    whatsappPhone: row.whatsappPhone || null,
    addressText: row.addressText || null,
    businessHours: row.businessHours || null,
    announcement: row.announcement || null,
    updatedAt: row.updatedAt,
  };
}

function localizeFaq(faq, lang) {
  const l = normalizeLanguage(lang);
  const t = l !== 'EN' && faq.translations && faq.translations[l] ? faq.translations[l] : null;
  return {
    id: faq.id,
    question: (t && t.name) || faq.questionEn,
    answer: (t && t.description) || faq.answerEn,
  };
}

/** Public: contact details, localized announcement and active FAQs. */
async function getPublicStore(lang = 'EN') {
  const l = normalizeLanguage(lang);
  const [row, faqs] = await Promise.all([
    getStoreRow(),
    prisma.faq.findMany({ where: { isActive: true }, orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }] }),
  ]);

  let announcement = row.announcement || null;
  if (announcement && l !== 'EN') {
    const tr = row.announcementTranslations && row.announcementTranslations[l];
    if (tr) announcement = tr;
    else translator.scheduleStore();
  }
  if (l !== 'EN') {
    faqs.filter((f) => !f.translations || !f.translations[l]).slice(0, 20).forEach((f) => translator.scheduleFaq(f.id));
  }

  return {
    store: { ...formatStore(row), announcement },
    faqs: faqs.map((f) => localizeFaq(f, l)),
  };
}

async function getAdminStore() {
  return formatStore(await getStoreRow());
}

const blank = (v) => (v === undefined ? undefined : v === null || String(v).trim() === '' ? null : String(v).trim());

function phoneOrNull(value, label) {
  const v = blank(value);
  if (v === undefined || v === null) return v;
  const { isValid, normalized } = normalizeUgandaPhone(v);
  if (!isValid) throw new AppError(`${label} must be a valid Uganda phone number (e.g. 0772 123 456)`, 422);
  return normalized;
}

async function updateStore(input) {
  const current = await getStoreRow();
  const data = {
    storeName: input.storeName !== undefined ? String(input.storeName).trim() || 'UgaMarket' : undefined,
    supportPhone: phoneOrNull(input.supportPhone, 'Support phone'),
    whatsappPhone: phoneOrNull(input.whatsappPhone, 'WhatsApp number'),
    supportEmail: blank(input.supportEmail) ? blank(input.supportEmail).toLowerCase() : blank(input.supportEmail),
    addressText: blank(input.addressText),
    businessHours: blank(input.businessHours),
    announcement: blank(input.announcement),
  };

  const announcementChanged = data.announcement !== undefined && data.announcement !== (current.announcement || null);
  if (announcementChanged) data.announcementTranslations = {};

  const saved = await prisma.storeProfile.update({ where: { id: STORE_ID }, data });
  if (announcementChanged && saved.announcement) translator.scheduleStore({ force: true });
  return formatStore(saved);
}

// ------------------------------------------------------------
// FAQs (admin)
// ------------------------------------------------------------
function formatAdminFaq(f) {
  return {
    id: f.id,
    question: f.questionEn,
    answer: f.answerEn,
    displayOrder: f.displayOrder,
    isActive: f.isActive,
    // Which languages already have a translation (shown as chips in the console).
    translatedLanguages: Object.keys(f.translations || {}),
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

async function listAdminFaqs() {
  const rows = await prisma.faq.findMany({ orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }] });
  return rows.map(formatAdminFaq);
}

async function createFaq({ question, answer, displayOrder, isActive = true }) {
  let order = displayOrder;
  if (order === undefined || order === null) {
    const last = await prisma.faq.findFirst({ orderBy: { displayOrder: 'desc' }, select: { displayOrder: true } });
    order = (last ? last.displayOrder : 0) + 10;
  }
  const created = await prisma.faq.create({
    data: { questionEn: question, answerEn: answer, displayOrder: order, isActive, translations: {} },
  });
  translator.scheduleFaq(created.id, { force: true });
  return formatAdminFaq(created);
}

async function updateFaq(id, { question, answer, displayOrder, isActive }) {
  const current = await prisma.faq.findUnique({ where: { id } });
  if (!current) throw new AppError('FAQ not found', 404);
  const englishChanged =
    (question !== undefined && question !== current.questionEn) || (answer !== undefined && answer !== current.answerEn);
  const saved = await prisma.faq.update({
    where: { id },
    data: {
      questionEn: question,
      answerEn: answer,
      displayOrder,
      isActive,
      ...(englishChanged ? { translations: {} } : {}),
    },
  });
  if (englishChanged) translator.scheduleFaq(id, { force: true });
  return formatAdminFaq(saved);
}

async function deleteFaq(id) {
  const current = await prisma.faq.findUnique({ where: { id } });
  if (!current) throw new AppError('FAQ not found', 404);
  await prisma.faq.delete({ where: { id } });
  return { id };
}

module.exports = {
  getPublicStore,
  getAdminStore,
  updateStore,
  listAdminFaqs,
  createFaq,
  updateFaq,
  deleteFaq,
};
