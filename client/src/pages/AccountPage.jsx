import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useParams } from 'react-router-dom';
import { api, dateOnly, money } from '../api.js';
import { useAuth } from '../state.jsx';
import { useToast } from '../components/Toast.jsx';
import AddressFields from '../components/AddressFields.jsx';
import OrderCard, { STATUSES } from '../components/OrderCard.jsx';

function ProfileTab() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({ name: user.name, email: user.email, phone: user.phone || '' });
  const [address, setAddress] = useState(user.address);
  const [busy, setBusy] = useState(false);
  const set = k => e => setForm({ ...form, [k]: e.target.value });

  const submit = async e => {
    e.preventDefault();
    setBusy(true);
    try {
      const updated = await api.updateMe({ ...form, address });
      setUser(updated);
      toast(updated.erpWarning || (updated.erpCustomer ? 'Profile saved (also updated in the ERP)' : 'Profile saved'),
            updated.erpWarning ? 'error' : 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form-grid three" onSubmit={submit}>
      <div className="span-all section-head"><h3>Personal information</h3></div>
      <label className="span-all">Full name<input value={form.name} onChange={set('name')} required /></label>
      <label className="span-2">E-mail<input type="email" value={form.email} onChange={set('email')} required /></label>
      <label>Phone<input value={form.phone} onChange={set('phone')} placeholder="optional" /></label>
      <h3 className="span-all">Shipping address</h3>
      <AddressFields value={address} onChange={setAddress} />
      <div className="span-all"><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button></div>
    </form>
  );
}

function SecurityTab() {
  const { setUser } = useAuth();
  const toast = useToast();
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', repeat: '' });
  const submit = async e => {
    e.preventDefault();
    if (pw.newPassword !== pw.repeat) return toast('The new passwords do not match', 'error');
    try {
      setUser(await api.updateMe({ currentPassword: pw.currentPassword, newPassword: pw.newPassword }));
      setPw({ currentPassword: '', newPassword: '', repeat: '' });
      toast('Password changed', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  return (
    <form className="card form-stack narrow-form" onSubmit={submit}>
      <h3>Change password</h3>
      <p className="muted small">Passwords are stored only as bcrypt hashes.</p>
      <label>Current password<input type="password" value={pw.currentPassword} onChange={e => setPw({ ...pw, currentPassword: e.target.value })} required /></label>
      <label>New password<input type="password" minLength="6" value={pw.newPassword} onChange={e => setPw({ ...pw, newPassword: e.target.value })} required /></label>
      <label>Repeat new password<input type="password" minLength="6" value={pw.repeat} onChange={e => setPw({ ...pw, repeat: e.target.value })} required /></label>
      <div><button className="primary">Change password</button></div>
    </form>
  );
}

function OrdersTab({ orders, setOrders }) {
  const [filter, setFilter] = useState('ALL');
  const replace = updated => setOrders(list => list.map(o => (o.id === updated.id ? updated : o)));
  const visible = (orders || []).filter(o => filter === 'ALL' || o.status === filter);
  const present = ['ALL', ...STATUSES.filter(s => (orders || []).some(o => o.status === s))];

  if (orders === null) return <p className="muted">Loading…</p>;
  if (orders.length === 0)
    return <div className="empty"><p>You have not ordered anything yet.</p><Link to="/" className="button primary">Start shopping</Link></div>;
  return (
    <>
      <div className="chips">
        {present.map(f => (
          <button key={f} className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
            {f === 'ALL' ? 'All' : f.charAt(0) + f.slice(1).toLowerCase()}
            <span>{(orders || []).filter(o => f === 'ALL' || o.status === f).length}</span>
          </button>
        ))}
      </div>
      <div className="stack">{visible.map(o => <OrderCard key={o.id} order={o} onChange={replace} />)}</div>
    </>
  );
}

export default function AccountPage() {
  const { tab = 'profile' } = useParams();
  const { user } = useAuth();
  const [orders, setOrders] = useState(null);

  useEffect(() => { api.orders().then(setOrders).catch(() => setOrders([])); }, []);

  const spent = useMemo(() => (orders || []).filter(o => o.status !== 'CANCELED').reduce((s, o) => s + o.total, 0), [orders]);

  return (
    <div className="container">
      <h1 className="page-title">My account</h1>
      <div className="account-layout">
        <aside className="account-side">
          <div className="card account-card">
            <span className="avatar large">{user.name.slice(0, 1).toUpperCase()}</span>
            <strong>{user.name}</strong>
            <span className="muted small">{user.email}</span>
            {user.memberSince && <span className="muted small">Customer since {dateOnly(user.memberSince)}</span>}
            {user.erpCustomer && <span className="tag erp">Customer in SAP ERP</span>}
            <div className="account-stats">
              <div><strong>{orders?.length ?? '–'}</strong><span>orders</span></div>
              <div><strong>{money(spent)}</strong><span>spent</span></div>
            </div>
          </div>
          <nav className="side-nav">
            <NavLink to="/account" end>Profile & address</NavLink>
            <NavLink to="/account/orders">Purchase history</NavLink>
            <NavLink to="/account/security">Password</NavLink>
          </nav>
        </aside>
        <section>
          {tab === 'orders' && <OrdersTab orders={orders} setOrders={setOrders} />}
          {tab === 'security' && <SecurityTab />}
          {tab !== 'orders' && tab !== 'security' && <ProfileTab />}
        </section>
      </div>
    </div>
  );
}
