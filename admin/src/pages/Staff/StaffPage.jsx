import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Pencil, Plus, Save, ShieldCheck, UserCheck, UserX } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/feedback/Toast';
import PageHeader from '../../components/ui/PageHeader';
import DataTable from '../../components/ui/DataTable';
import Modal from '../../components/ui/Modal';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { EmptyState, ErrorState } from '../../components/ui/states';
import { hasRole, useAuth } from '../../context/AuthContext';
import { formatDate, formatRole } from '../../utils/format';
import './StaffPage.css';

const ROLE_OPTIONS = [
  { value: 'DISPATCHER', label: 'Dispatcher', hint: 'Orders, deliveries, bookings, customer messages.' },
  { value: 'ADMIN', label: 'Admin', hint: 'Everything a dispatcher does, plus catalogue, pricing and storefront content.' },
  { value: 'SUPER_ADMIN', label: 'Super admin', hint: 'Full control, including staff accounts.' },
];
const ROLE_TONE = { SUPER_ADMIN: 'badge--danger', ADMIN: 'badge--info', DISPATCHER: 'badge--neutral' };
const EMPTY = { fullName: '', email: '', password: '', role: 'DISPATCHER' };

// Mirrors the backend rule (>= 10 chars, a letter and a number).
function passwordProblem(pw) {
  if (pw.length < 10) return 'Password must be at least 10 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and numbers.';
  return null;
}

/** Staff accounts for the Operations Console (super admins only): /api/admin/staff */
export default function StaffPage() {
  const { role, admin: me } = useAuth();
  const allowed = hasRole(role, ['SUPER_ADMIN']);
  const { showToast } = useToast();
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // 'new' | staff row
  const [form, setForm] = useState(EMPTY);
  const [resetFor, setResetFor] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  const [toggling, setToggling] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get('/admin/staff');
      setStaff(res?.data?.staff || []);
    } catch (err) {
      setError(err.message || 'Unable to load staff accounts.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);

  if (!allowed) {
    return (
      <div>
        <PageHeader title="Staff accounts" description="Manage who can sign in to the Operations Console." />
        <EmptyState title="Super admins only" message="Ask a super admin to add, change or remove staff accounts." />
      </div>
    );
  }

  const openEditor = (row) => {
    setEditing(row || 'new');
    setForm(row ? { fullName: row.fullName, email: row.email, password: '', role: row.role } : EMPTY);
    setFormError(null);
  };

  const save = async (e) => {
    e.preventDefault();
    const isNew = editing === 'new';
    if (form.fullName.trim().length < 2) return setFormError('Enter the staff member’s full name.');
    if (isNew && !/^\S+@\S+\.\S+$/.test(form.email.trim())) return setFormError('Enter a valid email address.');
    if (isNew) {
      const problem = passwordProblem(form.password);
      if (problem) return setFormError(problem);
    }
    setSaving(true);
    setFormError(null);
    try {
      if (isNew) {
        await api.post('/admin/staff', { fullName: form.fullName.trim(), email: form.email.trim(), password: form.password, role: form.role });
      } else {
        await api.patch(`/admin/staff/${editing.id}`, { fullName: form.fullName.trim(), role: form.role });
      }
      showToast(isNew ? 'Staff account created. Share the password with them securely.' : 'Staff account updated.', { type: 'success' });
      setEditing(null);
      load();
    } catch (err) {
      setFormError(err.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const resetPassword = async (e) => {
    e.preventDefault();
    const problem = passwordProblem(newPassword);
    if (problem) return setFormError(problem);
    setSaving(true);
    setFormError(null);
    try {
      await api.post(`/admin/staff/${resetFor.id}/reset-password`, { password: newPassword });
      showToast(`Password reset for ${resetFor.fullName}.`, { type: 'success' });
      setResetFor(null);
    } catch (err) {
      setFormError(err.message || 'Reset failed.');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async () => {
    const row = toggling;
    setToggling(null);
    try {
      await api.patch(`/admin/staff/${row.id}`, { isActive: !row.isActive });
      showToast(row.isActive ? `${row.fullName} can no longer sign in.` : `${row.fullName} can sign in again.`, { type: 'success' });
      load();
    } catch (err) {
      showToast(err.message || 'Update failed.', { type: 'error' });
    }
  };

  const columns = [
    {
      key: 'fullName',
      header: 'Staff member',
      render: (s) => (
        <span className="cell-stack">
          <strong>
            {s.fullName}
            {s.id === me?.id && <span className="staff-you">You</span>}
          </strong>
          <span className="text-muted">{s.email}</span>
        </span>
      ),
    },
    { key: 'role', header: 'Role', render: (s) => <span className={`badge ${ROLE_TONE[s.role] || 'badge--neutral'}`}>{formatRole(s.role)}</span> },
    { key: 'assignedDeliveries', header: 'Deliveries handled', render: (s) => s.assignedDeliveries ?? 0 },
    { key: 'createdAt', header: 'Added', render: (s) => formatDate(s.createdAt) },
    {
      key: 'isActive',
      header: 'Status',
      render: (s) => (s.isActive ? <span className="badge badge--success">Active</span> : <span className="badge badge--neutral">Deactivated</span>),
    },
    {
      key: 'actions',
      header: '',
      render: (s) => (
        <span className="staff-actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => openEditor(s)}>
            <Pencil size={13} aria-hidden="true" /> Edit
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setResetFor(s);
              setNewPassword('');
              setFormError(null);
            }}
          >
            <KeyRound size={13} aria-hidden="true" /> Reset password
          </button>
          {s.id !== me?.id && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setToggling(s)}>
              {s.isActive ? <UserX size={13} aria-hidden="true" /> : <UserCheck size={13} aria-hidden="true" />}
              {s.isActive ? 'Deactivate' : 'Reactivate'}
            </button>
          )}
        </span>
      ),
    },
  ];

  const isNew = editing === 'new';
  const selfEdit = editing && editing !== 'new' && editing.id === me?.id;

  return (
    <div>
      <PageHeader
        title="Staff accounts"
        description="Everyone who can sign in to the Operations Console. Deactivating an account signs that person out immediately."
        actions={
          <button type="button" className="btn btn--primary" onClick={() => openEditor(null)}>
            <Plus size={15} aria-hidden="true" /> Add staff member
          </button>
        }
      />

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <DataTable
          columns={columns}
          rows={staff}
          isLoading={loading}
          skeleton={<div className="panel panel-pad text-muted">Loading staff…</div>}
          emptyState={<EmptyState title="No staff yet" message="Add dispatchers and admins who help run UgaMarket." />}
        />
      )}

      <Modal open={Boolean(editing)} title={isNew ? 'Add staff member' : 'Edit staff member'} onClose={() => setEditing(null)} busy={saving} width={560}>
        <form onSubmit={save} noValidate>
          {formError && (
            <div className="alert alert--error" role="alert" style={{ marginBottom: 12 }}>
              <span>{formError}</span>
            </div>
          )}
          <div className="form-row">
            <div className="form-field">
              <label htmlFor="staff-name" className="required">
                Full name
              </label>
              <input id="staff-name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} disabled={saving} />
            </div>
            <div className="form-field">
              <label htmlFor="staff-email" className={isNew ? 'required' : undefined}>
                Email (sign-in)
              </label>
              <input
                id="staff-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                disabled={saving || !isNew}
                autoComplete="off"
              />
            </div>
          </div>
          {isNew && (
            <div className="form-field">
              <label htmlFor="staff-password" className="required">
                Temporary password
              </label>
              <input
                id="staff-password"
                type="text"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                disabled={saving}
                autoComplete="new-password"
              />
              <span className="field-hint">At least 10 characters with letters and numbers. Share it privately; you can reset it any time.</span>
            </div>
          )}
          <fieldset className="staff-roles" disabled={saving || selfEdit}>
            <legend>Role</legend>
            {ROLE_OPTIONS.map((r) => (
              <label key={r.value} className={`staff-role ${form.role === r.value ? 'staff-role--on' : ''}`}>
                <input type="radio" name="staff-role" value={r.value} checked={form.role === r.value} onChange={() => setForm({ ...form, role: r.value })} />
                <span>
                  <strong>
                    {r.value === 'SUPER_ADMIN' && <ShieldCheck size={13} aria-hidden="true" />} {r.label}
                  </strong>
                  <span className="text-muted">{r.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {selfEdit && <p className="field-hint">You cannot change your own role. Ask another super admin.</p>}
          <div className="modal__actions">
            <button type="button" className="btn btn--secondary" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={saving}>
              <Save size={14} aria-hidden="true" /> {saving ? 'Saving…' : isNew ? 'Create account' : 'Save changes'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(resetFor)} title="Reset password" onClose={() => setResetFor(null)} busy={saving} width={460}>
        <form onSubmit={resetPassword} noValidate>
          {formError && (
            <div className="alert alert--error" role="alert" style={{ marginBottom: 12 }}>
              <span>{formError}</span>
            </div>
          )}
          <p className="text-muted" style={{ marginBottom: 12 }}>
            Set a new password for <strong>{resetFor?.fullName}</strong>. Their old password stops working immediately.
          </p>
          <div className="form-field">
            <label htmlFor="staff-newpw" className="required">
              New password
            </label>
            <input id="staff-newpw" type="text" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} disabled={saving} autoComplete="new-password" />
            <span className="field-hint">At least 10 characters with letters and numbers.</span>
          </div>
          <div className="modal__actions">
            <button type="button" className="btn btn--secondary" onClick={() => setResetFor(null)} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={saving}>
              <KeyRound size={14} aria-hidden="true" /> {saving ? 'Saving…' : 'Reset password'}
            </button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={Boolean(toggling)}
        title={toggling?.isActive ? `Deactivate ${toggling?.fullName}?` : `Reactivate ${toggling?.fullName}?`}
        message={
          toggling?.isActive
            ? 'They are signed out immediately and cannot sign in until reactivated. Their order and delivery history is kept.'
            : 'They will be able to sign in again with their current password.'
        }
        confirmLabel={toggling?.isActive ? 'Deactivate' : 'Reactivate'}
        danger={Boolean(toggling?.isActive)}
        onConfirm={toggleActive}
        onCancel={() => setToggling(null)}
      />
    </div>
  );
}
