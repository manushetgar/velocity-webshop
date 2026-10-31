// AccountPage.jsx - My account (/account, login required) with three tabs: profile and address, purchase history
// (/account/orders) and password (/account/security).
//
// React hooks: effect (loading), memo (computed total), state.
import { useEffect, useMemo, useState } from 'react';
// Router: links, active-aware links and the :tab parameter.
import { Link, NavLink, useParams } from 'react-router-dom';
// API calls and formatting.
import { api, dateOnly, money } from '../api.js';
// Logged-in user.
import { useAuth } from '../state.jsx';
// Notifications.
import { useToast } from '../components/Toast.jsx';
// Address inputs.
import AddressFields from '../components/AddressFields.jsx';
// Order cards and the list of statuses.
import OrderCard, { STATUSES } from '../components/OrderCard.jsx';

// Tab 1: personal information and shipping address.
function ProfileTab() {
  // The user and the setter for the updated profile.
  const { user, setUser } = useAuth();
  // Notifications.
  const toast = useToast();
  // Personal data of the form, prefilled.
  const [form, setForm] = useState({ name: user.name, email: user.email, phone: user.phone || '' });
  // Address of the form, prefilled.
  const [address, setAddress] = useState(user.address);
  // true while saving.
  const [busy, setBusy] = useState(false);
  // Change handler for one field.
  const set = k => e => setForm({ ...form, [k]: e.target.value });

  // Saves the profile (PUT /api/me); the server also updates the customer in the ERP.
  const submit = async e => {
    // No page reload.
    e.preventDefault();
    // Disable the button.
    setBusy(true);
    try {
      // Send personal data and address.
      const updated = await api.updateMe({ ...form, address });
      // Updated user in the global state (header shows the new name).
      setUser(updated);
      // Message: ERP warning (shop saved, ERP not), or saved (with or without ERP).
      toast(updated.erpWarning || (updated.erpCustomer ? 'Profile saved (also updated in the ERP)' : 'Profile saved'),
            updated.erpWarning ? 'error' : 'success');
    } catch (err) {
      // Error message (e.g. e-mail already used).
      toast(err.message, 'error');
    } finally {
      // Enable the button again.
      setBusy(false);
    }
  };

  // The form markup.
  return (
    // Card with a three-column form grid.
    <form className="card form-grid three" onSubmit={submit}>
      {/* Section title. */}
      <div className="span-all section-head"><h3>Personal information</h3></div>
      {/* Full name. */}
      <label className="span-all">Full name<input value={form.name} onChange={set('name')} required /></label>
      {/* E-mail. */}
      <label className="span-2">E-mail<input type="email" value={form.email} onChange={set('email')} required /></label>
      {/* Phone. */}
      <label>Phone<input value={form.phone} onChange={set('phone')} placeholder="optional" /></label>
      {/* Address section. */}
      <h3 className="span-all">Shipping address</h3>
      {/* Address inputs. */}
      <AddressFields value={address} onChange={setAddress} />
      {/* Save button. */}
      <div className="span-all"><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button></div>
    </form>
  );
}

// Tab 3: change the password.
function SecurityTab() {
  // Setter for the updated user.
  const { setUser } = useAuth();
  // Notifications.
  const toast = useToast();
  // The three password fields.
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', repeat: '' });
  // Sends the password change.
  const submit = async e => {
    // No page reload.
    e.preventDefault();
    // Both new passwords must be the same.
    if (pw.newPassword !== pw.repeat) return toast('The new passwords do not match', 'error');
    try {
      // PUT /api/me with the current and the new password (the server checks the current one).
      setUser(await api.updateMe({ currentPassword: pw.currentPassword, newPassword: pw.newPassword }));
      // Clear the fields.
      setPw({ currentPassword: '', newPassword: '', repeat: '' });
      // Confirmation.
      toast('Password changed', 'success');
    } catch (err) {
      // Error message (e.g. wrong current password).
      toast(err.message, 'error');
    }
  };
  // The form markup.
  return (
    // Narrow card with stacked fields.
    <form className="card form-stack narrow-form" onSubmit={submit}>
      {/* Title. */}
      <h3>Change password</h3>
      {/* Hint how passwords are stored. */}
      <p className="muted small">Passwords are stored only as bcrypt hashes.</p>
      {/* Current password. */}
      <label>Current password<input type="password" value={pw.currentPassword} onChange={e => setPw({ ...pw, currentPassword: e.target.value })} required /></label>
      {/* New password (at least 6 characters). */}
      <label>New password<input type="password" minLength="6" value={pw.newPassword} onChange={e => setPw({ ...pw, newPassword: e.target.value })} required /></label>
      {/* Repeat the new password. */}
      <label>Repeat new password<input type="password" minLength="6" value={pw.repeat} onChange={e => setPw({ ...pw, repeat: e.target.value })} required /></label>
      {/* Submit button. */}
      <div><button className="primary">Change password</button></div>
    </form>
  );
}

// Tab 2: purchase history with a status filter.
function OrdersTab({ orders, setOrders }) {
  // Selected status filter.
  const [filter, setFilter] = useState('ALL');
  // Replaces one order in the list after a change (e.g. canceled).
  const replace = updated => setOrders(list => list.map(o => (o.id === updated.id ? updated : o)));
  // Orders shown with the current filter.
  const visible = (orders || []).filter(o => filter === 'ALL' || o.status === filter);
  // Filter chips: All plus the statuses that actually occur.
  const present = ['ALL', ...STATUSES.filter(s => (orders || []).some(o => o.status === s))];

  // Still loading.
  if (orders === null) return <p className="muted">Loading…</p>;
  // No orders yet: link to the shop.
  if (orders.length === 0)
    // Empty state.
    return <div className="empty"><p>You have not ordered anything yet.</p><Link to="/" className="button primary">Start shopping</Link></div>;
  // The list.
  return (
    // Fragment: chips and list without an extra wrapper.
    <>
      {/* Filter chips. */}
      <div className="chips">
        {/* One chip per filter. */}
        {present.map(f => (
          // Chip button (highlighted when active).
          <button key={f} className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
            {/* Label: All or the status in normal case (Shipped). */}
            {f === 'ALL' ? 'All' : f.charAt(0) + f.slice(1).toLowerCase()}
            {/* Number of orders with that status. */}
            <span>{(orders || []).filter(o => f === 'ALL' || o.status === f).length}</span>
          </button>
        ))}
      </div>
      {/* The order cards (customer view: cancel while NEW). */}
      <div className="stack">{visible.map(o => <OrderCard key={o.id} order={o} onChange={replace} />)}</div>
    </>
  );
}

// The account page.
export default function AccountPage() {
  // Tab from the URL (/account/:tab), profile by default.
  const { tab = 'profile' } = useParams();
  // Logged-in user.
  const { user } = useAuth();
  // Own orders (null while loading).
  const [orders, setOrders] = useState(null);

  // Load the own orders once (GET /api/orders); an error shows an empty list.
  useEffect(() => { api.orders().then(setOrders).catch(() => setOrders([])); }, []);

  // Total spent, without canceled orders; computed again only when the orders change.
  const spent = useMemo(() => (orders || []).filter(o => o.status !== 'CANCELED').reduce((s, o) => s + o.total, 0), [orders]);

  // The page markup.
  return (
    // Centered page width.
    <div className="container">
      {/* Page title. */}
      <h1 className="page-title">My account</h1>
      {/* Side column + content. */}
      <div className="account-layout">
        {/* Side column. */}
        <aside className="account-side">
          {/* Account card. */}
          <div className="card account-card">
            {/* Avatar with the first letter. */}
            <span className="avatar large">{user.name.slice(0, 1).toUpperCase()}</span>
            {/* Name. */}
            <strong>{user.name}</strong>
            {/* E-mail. */}
            <span className="muted small">{user.email}</span>
            {/* Registration date. */}
            {user.memberSince && <span className="muted small">Customer since {dateOnly(user.memberSince)}</span>}
            {/* Tag if the customer also exists in the SAP ERP. */}
            {user.erpCustomer && <span className="tag erp">Customer in SAP ERP</span>}
            {/* Small statistics. */}
            <div className="account-stats">
              {/* Number of orders. */}
              <div><strong>{orders?.length ?? '–'}</strong><span>orders</span></div>
              {/* Money spent. */}
              <div><strong>{money(spent)}</strong><span>spent</span></div>
            </div>
          </div>
          {/* Tab navigation. */}
          <nav className="side-nav">
            {/* Profile tab. */}
            <NavLink to="/account" end>Profile & address</NavLink>
            {/* Orders tab. */}
            <NavLink to="/account/orders">Purchase history</NavLink>
            {/* Password tab. */}
            <NavLink to="/account/security">Password</NavLink>
          </nav>
        </aside>
        {/* Content of the selected tab. */}
        <section>
          {/* Orders. */}
          {tab === 'orders' && <OrdersTab orders={orders} setOrders={setOrders} />}
          {/* Password. */}
          {tab === 'security' && <SecurityTab />}
          {/* Profile (default). */}
          {tab !== 'orders' && tab !== 'security' && <ProfileTab />}
        </section>
      </div>
    </div>
  );
}
