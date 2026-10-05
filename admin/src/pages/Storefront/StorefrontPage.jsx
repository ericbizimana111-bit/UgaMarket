import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Eye, EyeOff, HelpCircle, Languages, Megaphone, Pencil, Plus, Save, Store, Trash2 } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/feedback/Toast';
import PageHeader from '../../components/ui/PageHeader';
import Modal from '../../components/ui/Modal';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { EmptyState, ErrorState } from '../../components/ui/states';
import { CATALOG_ROLES, hasRole, useAuth } from '../../context/AuthContext';
import './StorefrontPage.css';

const STORE_FIELDS = ['storeName', 'supportPhone', 'whatsappPhone', 'supportEmail', 'addressText', 'businessHours', 'announcement'];
const EMPTY_STORE = Object.fromEntries(STORE_FIELDS.map((k) => [k, '']));
const EMPTY_FAQ = { question: '', answer: '', isActive: true };
const LANG_LABEL = { LG: 'Luganda', SW: 'Kiswahili', FR: 'French' };
const isUgPhone = (v) => !v.trim() || /^(?:\+?256|0)?[37]\d{8}$/.test(v.replace(/[\s\-().]/g, ''));

/**
 * Storefront content: public contact details, the top-bar announcement and
 * the FAQ shown on "How it works". Admins write English; the other
 * storefront languages are translated automatically.
 */
export default function StorefrontPage() {
  const { role } = useAuth();
  const canEdit = hasRole(role, CATALOG_ROLES);
  const { showToast } = useToast();

  const [store, setStore] = useState(EMPTY_STORE);
  const [faqs, setFaqs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [savingStore, setSavingStore] = useState(false);
  const [storeError, setStoreError] = useState(null);

  const [editing, setEditing] = useState(null); // 'new' | faq
  const [faqForm, setFaqForm] = useState(EMPTY_FAQ);
  const [faqError, setFaqError] = useState(null);
  const [savingFaq, setSavingFaq] = useState(false);
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, f] = await Promise.all([api.get('/admin/content/store'), api.get('/admin/content/faqs')]);
      const row = s?.data?.store || {};
      setStore(Object.fromEntries(STORE_FIELDS.map((k) => [k, row[k] || ''])));
      setFaqs(f?.data?.faqs || []);
    } catch (err) {
      setError(err.message || 'Unable to load storefront content.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const set = (key) => (e) => setStore((s) => ({ ...s, [key]: e.target.value }));

  const saveStore = async (e) => {
    e.preventDefault();
    if (store.storeName.trim().length < 2) return setStoreError('Enter the store name.');
    if (!isUgPhone(store.supportPhone) || !isUgPhone(store.whatsappPhone)) return setStoreError('Phone numbers must be valid Ugandan numbers, e.g. 0772 123 456.');
    if (store.supportEmail.trim() && !/^\S+@\S+\.\S+$/.test(store.supportEmail.trim())) return setStoreError('Enter a valid support email address.');
    setSavingStore(true);
    setStoreError(null);
    try {
      const payload = Object.fromEntries(STORE_FIELDS.map((k) => [k, store[k].trim()]));
      const res = await api.put('/admin/content/store', payload);
      const row = res?.data?.store || {};
      setStore(Object.fromEntries(STORE_FIELDS.map((k) => [k, row[k] || ''])));
      showToast('Store details saved. Customers see them right away.', { type: 'success' });
    } catch (err) {
      setStoreError(err.message || 'Save failed.');
    } finally {
      setSavingStore(false);
    }
  };

  const openFaq = (faq) => {
    setEditing(faq || 'new');
    setFaqForm(faq ? { question: faq.question, answer: faq.answer, isActive: faq.isActive } : EMPTY_FAQ);
    setFaqError(null);
  };

  const saveFaq = async (e) => {
    e.preventDefault();
    if (faqForm.question.trim().length < 5) return setFaqError('Write the question (at least 5 characters).');
    if (faqForm.answer.trim().length < 5) return setFaqError('Write the answer (at least 5 characters).');
    setSavingFaq(true);
    setFaqError(null);
    const payload = { question: faqForm.question.trim(), answer: faqForm.answer.trim(), isActive: faqForm.isActive };
    try {
      if (editing === 'new') await api.post('/admin/content/faqs', payload);
      else await api.put(`/admin/content/faqs/${editing.id}`, payload);
      showToast(editing === 'new' ? 'Question added. Translations are generated automatically.' : 'Question saved.', { type: 'success' });
      setEditing(null);
      load();
    } catch (err) {
      setFaqError(err.message || 'Save failed.');
    } finally {
      setSavingFaq(false);
    }
  };

  const toggleFaq = async (faq) => {
    try {
      await api.put(`/admin/content/faqs/${faq.id}`, { isActive: !faq.isActive });
      load();
    } catch (err) {
      showToast(err.message || 'Update failed.', { type: 'error' });
    }
  };

  // Swap display order with the neighbour (orders are re-spaced so ties never stick).
  const move = async (index, dir) => {
    const target = index + dir;
    if (target < 0 || target >= faqs.length) return;
    const reordered = [...faqs];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    setFaqs(reordered);
    try {
      await Promise.all(
        reordered.map((f, i) => ((i + 1) * 10 !== f.displayOrder ? api.put(`/admin/content/faqs/${f.id}`, { displayOrder: (i + 1) * 10 }) : null)),
      );
      load();
    } catch (err) {
      showToast(err.message || 'Reorder failed.', { type: 'error' });
      load();
    }
  };

  const confirmDelete = async () => {
    const faq = deleting;
    setDeleting(null);
    try {
      await api.delete(`/admin/content/faqs/${faq.id}`);
      showToast('Question deleted.', { type: 'success' });
      load();
    } catch (err) {
      showToast(err.message || 'Delete failed.', { type: 'error' });
    }
  };

  if (error) {
    return (
      <div>
        <PageHeader title="Storefront content" />
        <ErrorState message={error} onRetry={load} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Storefront content"
        description="What customers see on the website: how to reach you, the announcement bar and frequently asked questions. Write in English; Luganda, Kiswahili and French are translated automatically."
      />

      <form className="panel panel-pad storefront-card" onSubmit={saveStore} noValidate aria-busy={loading}>
        <h3 className="storefront-title">
          <Store size={16} aria-hidden="true" /> Contact details
        </h3>
        <p className="field-hint">Shown in the website footer. Leave a field empty to hide it.</p>
        {storeError && (
          <div className="alert alert--error" role="alert" style={{ marginBottom: 12 }}>
            <span>{storeError}</span>
          </div>
        )}
        <fieldset disabled={!canEdit || savingStore || loading} className="storefront-fields">
          <div className="form-row">
            <div className="form-field">
              <label htmlFor="sf-name" className="required">
                Store name
              </label>
              <input id="sf-name" value={store.storeName} onChange={set('storeName')} maxLength={100} />
            </div>
            <div className="form-field">
              <label htmlFor="sf-email">Support email</label>
              <input id="sf-email" type="email" value={store.supportEmail} onChange={set('supportEmail')} placeholder="support@yourdomain.ug" maxLength={255} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-field">
              <label htmlFor="sf-phone">Support phone</label>
              <input id="sf-phone" type="tel" value={store.supportPhone} onChange={set('supportPhone')} placeholder="07XX XXX XXX" />
            </div>
            <div className="form-field">
              <label htmlFor="sf-wa">WhatsApp number</label>
              <input id="sf-wa" type="tel" value={store.whatsappPhone} onChange={set('whatsappPhone')} placeholder="07XX XXX XXX" />
            </div>
          </div>
          <div className="form-row">
            <div className="form-field">
              <label htmlFor="sf-addr">Office / shop address</label>
              <input id="sf-addr" value={store.addressText} onChange={set('addressText')} placeholder="e.g. Plot 5, Kampala Road, Kampala" maxLength={300} />
            </div>
            <div className="form-field">
              <label htmlFor="sf-hours">Business hours</label>
              <input id="sf-hours" value={store.businessHours} onChange={set('businessHours')} placeholder="e.g. Mon–Sat, 8am–8pm" maxLength={150} />
            </div>
          </div>

          <h3 className="storefront-title storefront-title--gap">
            <Megaphone size={16} aria-hidden="true" /> Announcement bar
          </h3>
          <div className="form-field">
            <label htmlFor="sf-ann">Message</label>
            <input id="sf-ann" value={store.announcement} onChange={set('announcement')} placeholder="e.g. Free delivery within Kampala this weekend" maxLength={200} />
            <span className="field-hint">
              Shown across the top of every page. Leave empty to show the default message. {store.announcement.length}/200
            </span>
          </div>
        </fieldset>
        {canEdit && (
          <div className="storefront-actions">
            <button type="submit" className="btn btn--primary" disabled={savingStore || loading}>
              <Save size={14} aria-hidden="true" /> {savingStore ? 'Saving…' : 'Save store details'}
            </button>
          </div>
        )}
      </form>

      <section className="panel panel-pad storefront-card" aria-labelledby="faq-heading">
        <div className="storefront-head">
          <div>
            <h3 id="faq-heading" className="storefront-title">
              <HelpCircle size={16} aria-hidden="true" /> Frequently asked questions
            </h3>
            <p className="field-hint">Shown on the “How it works” page, in this order. Hidden questions stay here for later.</p>
          </div>
          {canEdit && (
            <button type="button" className="btn btn--primary" onClick={() => openFaq(null)}>
              <Plus size={15} aria-hidden="true" /> Add question
            </button>
          )}
        </div>

        {loading ? (
          <p className="text-muted">Loading questions…</p>
        ) : faqs.length === 0 ? (
          <EmptyState title="No questions yet" message="Add the questions customers ask most often about orders, delivery and payment." />
        ) : (
          <ol className="faq-admin">
            {faqs.map((f, i) => (
              <li key={f.id} className={`faq-admin__item ${f.isActive ? '' : 'faq-admin__item--hidden'}`}>
                {canEdit && (
                  <span className="faq-admin__order">
                    <button type="button" className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move “${f.question}” up`}>
                      <ArrowUp size={14} aria-hidden="true" />
                    </button>
                    <button type="button" className="icon-btn" onClick={() => move(i, 1)} disabled={i === faqs.length - 1} aria-label={`Move “${f.question}” down`}>
                      <ArrowDown size={14} aria-hidden="true" />
                    </button>
                  </span>
                )}
                <div className="faq-admin__body">
                  <strong>{f.question}</strong>
                  <p>{f.answer}</p>
                  <span className="faq-admin__meta">
                    {!f.isActive && <span className="badge badge--neutral">Hidden</span>}
                    <Languages size={12} aria-hidden="true" />
                    {Object.keys(LANG_LABEL).map((code) => (
                      <span key={code} className={`faq-admin__lang ${f.translatedLanguages.includes(code) ? 'faq-admin__lang--done' : ''}`} title={f.translatedLanguages.includes(code) ? `${LANG_LABEL[code]} ready` : `${LANG_LABEL[code]} pending (English shown meanwhile)`}>
                        {code}
                      </span>
                    ))}
                  </span>
                </div>
                {canEdit && (
                  <span className="faq-admin__actions">
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => toggleFaq(f)}>
                      {f.isActive ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />} {f.isActive ? 'Hide' : 'Show'}
                    </button>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => openFaq(f)}>
                      <Pencil size={13} aria-hidden="true" /> Edit
                    </button>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDeleting(f)} aria-label={`Delete “${f.question}”`}>
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <Modal open={Boolean(editing)} title={editing === 'new' ? 'Add question' : 'Edit question'} onClose={() => setEditing(null)} busy={savingFaq} width={600}>
        <form onSubmit={saveFaq} noValidate>
          {faqError && (
            <div className="alert alert--error" role="alert" style={{ marginBottom: 12 }}>
              <span>{faqError}</span>
            </div>
          )}
          <div className="form-field">
            <label htmlFor="faq-q" className="required">
              Question (English)
            </label>
            <input id="faq-q" value={faqForm.question} onChange={(e) => setFaqForm({ ...faqForm, question: e.target.value })} maxLength={200} disabled={savingFaq} />
          </div>
          <div className="form-field">
            <label htmlFor="faq-a" className="required">
              Answer (English)
            </label>
            <textarea id="faq-a" rows={5} value={faqForm.answer} onChange={(e) => setFaqForm({ ...faqForm, answer: e.target.value })} maxLength={3000} disabled={savingFaq} />
            <span className="field-hint">Changing the English text re-translates the other languages automatically.</span>
          </div>
          <label className="toolbar__check">
            <input type="checkbox" checked={faqForm.isActive} onChange={(e) => setFaqForm({ ...faqForm, isActive: e.target.checked })} disabled={savingFaq} /> Show on the website
          </label>
          <div className="modal__actions">
            <button type="button" className="btn btn--secondary" onClick={() => setEditing(null)} disabled={savingFaq}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={savingFaq}>
              <Save size={14} aria-hidden="true" /> {savingFaq ? 'Saving…' : 'Save question'}
            </button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete this question?"
        message={`“${deleting?.question || ''}” will be removed from the website in every language. To keep it for later, hide it instead.`}
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
