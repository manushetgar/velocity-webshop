import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useParams } from 'react-router-dom';
import { api, dateOnly, dateTime, money } from '../api.js';
import { useToast } from '../components/Toast.jsx';
import Modal from '../components/Modal.jsx';
import ProductArt from '../components/ProductArt.jsx';
import OrderCard, { STATUSES, StatusBadge } from '../components/OrderCard.jsx';
import SapConnectors from '../components/SapConnectors.jsx';
import FileTransfer from '../components/FileTransfer.jsx';
import Suppliers from '../components/Suppliers.jsx';

const CATEGORIES = ['Bikes', 'E-Bikes', 'Accessories', 'Apparel', 'Other'];

function Overview() {
  const [stats, setStats] = useState(null);
  const [orders, setOrders] = useState([]);
  useEffect(() => {
    api.stats().then(setStats).catch(() => {});
    api.orders(true).then(o => setOrders(o.slice(0, 5))).catch(() => {});
  }, []);
  if (!stats) return <p className="muted">Loading…</p>;
  const maxStatus = Math.max(1, ...Object.values(stats.byStatus));

  return (
    <div className="stack">
      <div className="kpis">
        <div className="kpi"><span className="kpi-label">Revenue</span><span className="kpi-value">{money(stats.revenue)}</span><span className="kpi-sub">excl. canceled orders</span></div>
        <div className="kpi"><span className="kpi-label">Orders</span><span className="kpi-value">{stats.orders}</span><span className="kpi-sub">{stats.openOrders} open · {stats.ordersInErp} in SAP ERP</span></div>
        <div className="kpi"><span className="kpi-label">Customers</span><span className="kpi-value">{stats.customers}</span><span className="kpi-sub">registered accounts</span></div>
        <div className="kpi"><span className="kpi-label">Products</span><span className="kpi-value">{stats.products}</span><span className="kpi-sub">{stats.lowStock.length} low on stock</span></div>
      </div>

      <div className="two-col even">
        <section className="card">
          <h3>Orders by status</h3>
          {stats.orders === 0 && <p className="muted small">No orders yet.</p>}
          <ul className="bars">
            {STATUSES.filter(s => stats.byStatus[s]).map(s => (
              <li key={s} title={`${s}: ${stats.byStatus[s]} orders`}>
                <span className="bar-label">{s.charAt(0) + s.slice(1).toLowerCase()}</span>
                <span className="bar-track"><span className="bar-fill" style={{ width: `${(stats.byStatus[s] / maxStatus) * 100}%` }} /></span>
                <span className="bar-value">{stats.byStatus[s]}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h3>Low stock</h3>
          {stats.lowStock.length === 0 && <p className="muted small">All products have enough stock.</p>}
          <ul className="simple-list">
            {stats.lowStock.map(p => (
              <li key={p.id}><span>{p.name} <span className="muted small">{p.productId}</span></span>
                <span className={`stock ${p.stock === 0 ? 'out' : 'low'}`}>{p.stock === 0 ? 'Out of stock' : `${p.stock} left`}</span></li>
            ))}
          </ul>
        </section>
      </div>

      <section className="card">
        <div className="section-head"><h3>Latest orders</h3><Link to="/admin/orders">All orders</Link></div>
        {orders.length === 0 ? <p className="muted small">No orders yet.</p> : (
          <table className="table">
            <thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Status</th><th className="right">Total</th></tr></thead>
            <tbody>
              {orders.map(o => (
                <tr key={o.id}>
                  <td>#{o.id}{o.erpOrderNumber && <span className="tag erp">ERP #{o.erpOrderNumber}</span>}</td>
                  <td>{o.customer.name}</td><td>{dateTime(o.orderDate)}</td>
                  <td><StatusBadge status={o.status} /></td><td className="right">{money(o.total, o.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

const EMPTY_PRODUCT = { productId: '', name: '', description: '', price: '', stock: '0', category: 'Bikes' };

function ProductForm({ initial, erpOn, fileMode, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !initial.id;
  const [form, setForm] = useState({ ...EMPTY_PRODUCT, ...initial, price: String(initial.price ?? ''), stock: String(initial.stock ?? '0') });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = k => e => setForm({ ...form, [k]: e.target.value });

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const body = { name: form.name, description: form.description, price: form.price, stock: form.stock, category: form.category };
      if (isNew) await api.addProduct({ ...body, productId: form.productId });
      else await api.updateProduct(initial.id, body);
      toast(isNew ? `${form.name} created` : `${form.name} saved`, 'success');
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={isNew ? 'New product' : `Edit ${initial.name}`} onClose={onClose}
           footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="form-grid">
        <label>Product ID<input value={form.productId} onChange={set('productId')} disabled={!isNew} placeholder="e.g. DXTR2000" /></label>
        <label>Category
          <select value={form.category} onChange={set('category')}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select>
        </label>
        <label className="span-all">Name<input value={form.name} onChange={set('name')} disabled={fileMode} /></label>
        <label className="span-all">Description<textarea rows="3" value={form.description} onChange={set('description')} disabled={fileMode} /></label>
        <label>Price (EUR)<input type="number" min="0" step="0.01" value={form.price} onChange={set('price')} disabled={fileMode} /></label>
        <label>Stock<input type="number" min="0" max="1000" step="1" value={form.stock} onChange={set('stock')} disabled={fileMode} /></label>
      </div>
      {fileMode
        ? <p className="muted small">File transfer mode: name, description, price and stock come from the ERP's export file and can only be changed in the ERP. The category is shop data.</p>
        : erpOn && <p className="muted small">Saved in the SAP ERP of the active connector first; the shop takes over the ERP data.</p>}
      {error && <p className="error small">{error}</p>}
    </Modal>
  );
}

function Products() {
  const toast = useToast();
  const [products, setProducts] = useState(null);
  const [query, setQuery] = useState('');
  const [showRemoved, setShowRemoved] = useState(false);
  const [editing, setEditing] = useState(null);
  const [erp, setErp] = useState(null);

  const load = () => api.products(true).then(setProducts).catch(e => toast(e.message, 'error'));
  useEffect(() => { load(); api.erpStatus().then(setErp).catch(() => {}); }, []);
  const erpOn = !!erp?.configured;
  const fileMode = erp?.integration === 'file';

  const toggle = async p => {
    try {
      if (p.active) {
        if (!confirm(`Remove "${p.name}" from the shop? It stays in the ERP and can be restored.`)) return;
        await api.removeProduct(p.id);
        toast(`${p.name} removed from the shop`, 'info');
      } else {
        await api.updateProduct(p.id, { active: true });
        toast(`${p.name} restored`, 'success');
      }
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const visible = (products || [])
    .filter(p => showRemoved || p.active)
    .filter(p => !query || `${p.name} ${p.productId} ${p.category}`.toLowerCase().includes(query.toLowerCase()));

  return (
    <section className="card">
      <div className="section-head">
        <div>
          <h3>Products <span className="muted">({visible.length})</span></h3>
          <p className="muted small">
            {fileMode ? <>From <Link to="/admin/file-transfer">{erp.connector.name} via file transfer</Link> – master data is changed in the ERP and arrives with the next file.</>
              : erpOn ? <>From <Link to="/admin/connectors">{erp.connector.name}</Link> – changes are saved in that ERP first.</>
              : 'Standalone mode – products and stock are kept in the shop only.'}
          </p>
        </div>
        <div className="toolbar">
          <input type="search" placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search products" />
          <label className="check"><input type="checkbox" checked={showRemoved} onChange={e => setShowRemoved(e.target.checked)} /> Show removed</label>
          <button className="primary" disabled={fileMode} title={fileMode ? 'In file transfer mode new products are created in the ERP' : ''}
                  onClick={() => setEditing({ ...EMPTY_PRODUCT })}>New product</button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Product</th><th>Category</th><th className="right">Price</th><th className="right">Stock</th><th>Source</th><th /></tr></thead>
          <tbody>
            {visible.map(p => (
              <tr key={p.id} className={p.active ? '' : 'inactive'}>
                <td>
                  <div className="cell-product">
                    <ProductArt product={p} size="mini" />
                    <span><strong>{p.name}</strong><span className="muted small">{p.productId}</span></span>
                  </div>
                </td>
                <td>{p.category}</td>
                <td className="right">{money(p.price, p.currency)}</td>
                <td className="right"><span className={`stock ${p.stock === 0 ? 'out' : p.stock <= 5 ? 'low' : 'in'}`}>{p.stock}</span></td>
                <td>
                  {p.erpManaged ? <span className="tag erp">{p.erpSource === 'file' ? 'SAP ERP · file' : 'SAP ERP'}</span> : <span className="tag">Shop</span>}
                  {!p.active && <span className="tag">removed</span>}
                  {p.erpManaged && p.erpCreatedBy !== null && (
                    <span className="source-note" title={p.erpCreatedBy ? `createdBy in the ERP: ${p.erpCreatedBy}` : 'loaded with the ERP data (CSV)'}>
                      {p.erpCreatedBy ? 'added via API' : 'ERP initial data'}
                    </span>
                  )}
                </td>
                <td className="right nowrap">
                  <button className="link" onClick={() => setEditing(p)}>Edit</button>
                  <button className={`link ${p.active ? 'danger' : ''}`} onClick={() => toggle(p)}>{p.active ? 'Remove' : 'Restore'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {products?.length === 0 && (
        <div className="empty">
          {erpOn ? <>No products from {erp.connector.name} yet{erp.lastSync?.ok === false ? ` – ${erp.lastSync.error}` : ''}.
            <Link to="/admin/connectors" className="button">Open SAP connectors</Link></> : 'No products yet.'}
        </div>
      )}
      {editing && <ProductForm initial={editing} erpOn={erpOn} fileMode={fileMode && !!editing.id} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </section>
  );
}

function Orders() {
  const [orders, setOrders] = useState(null);
  const [filter, setFilter] = useState('ALL');
  useEffect(() => { api.orders(true).then(setOrders).catch(() => setOrders([])); }, []);
  const replace = updated => setOrders(list => list.map(o => (o.id === updated.id ? updated : o)));
  const count = f => (orders || []).filter(o => f === 'ALL' || o.status === f).length;
  if (orders === null) return <p className="muted">Loading…</p>;
  return (
    <>
      <div className="chips">
        {['ALL', ...STATUSES].map(f => (
          <button key={f} className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
            {f === 'ALL' ? 'All' : f.charAt(0) + f.slice(1).toLowerCase()} <span>{count(f)}</span>
          </button>
        ))}
      </div>
      {orders.length === 0 && <div className="empty">No orders yet.</div>}
      <div className="stack">
        {orders.filter(o => filter === 'ALL' || o.status === filter)
          .map(o => <OrderCard key={o.id} order={o} isAdmin showCustomer onChange={replace} />)}
      </div>
    </>
  );
}

function Customers() {
  const [customers, setCustomers] = useState(null);
  useEffect(() => { api.customers().then(setCustomers).catch(() => setCustomers([])); }, []);
  if (customers === null) return <p className="muted">Loading…</p>;
  return (
    <section className="card">
      <h3>Customers <span className="muted">({customers.filter(c => c.role === 'customer').length})</span></h3>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Name</th><th>E-mail</th><th>City</th><th>Since</th><th className="right">Orders</th><th className="right">Spent</th><th>ERP</th></tr></thead>
          <tbody>
            {customers.map(c => (
              <tr key={c.id}>
                <td><strong>{c.name}</strong>{c.role === 'admin' && <span className="tag">admin</span>}</td>
                <td>{c.email}</td><td>{c.city || '–'}</td><td>{dateOnly(c.memberSince)}</td>
                <td className="right">{c.orders}</td><td className="right">{money(c.spent)}</td>
                <td>{c.erpCustomer ? <span className="tag erp">linked</span> : <span className="muted small">–</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const TABS = [
  ['overview', 'Overview'], ['products', 'Products'], ['orders', 'Orders'], ['customers', 'Customers'], ['connectors', 'SAP connectors'],
  ['file-transfer', 'File transfer'], ['suppliers', 'Suppliers'],
];

function ConnectionChip({ tab }) {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    const load = () => api.erpStatus().then(setStatus).catch(() => {});
    load();
    window.addEventListener('sap-connector-changed', load);
    return () => window.removeEventListener('sap-connector-changed', load);
  }, [tab]);
  if (!status) return null;
  const c = status.connector;
  const state = !c ? 'idle' : status.lastSync?.ok === false ? 'bad' : status.lastSync?.ok ? 'good' : 'idle';
  return (
    <Link to="/admin/connectors" className="connection-chip" title="Change in SAP connectors">
      <span className={`dot ${state}`} />
      <span><small>SAP connector{c?.integration === 'file' ? ' · file transfer' : ''}</small>{c ? c.name : 'none (standalone)'}</span>
    </Link>
  );
}

export default function AdminPage() {
  const { tab = 'overview' } = useParams();
  const current = useMemo(() => (tab === 'erp' ? 'connectors' : TABS.some(([k]) => k === tab) ? tab : 'overview'), [tab]);
  return (
    <div className="container">
      <div className="admin-head">
        <div>
          <h1 className="page-title">Admin</h1>
          <p className="muted">Manage products, orders and customers. Product and order data live in the SAP ERP.</p>
        </div>
        <ConnectionChip tab={current} />
      </div>
      <nav className="tabs">
        {TABS.map(([k, label]) => (
          <NavLink key={k} to={k === 'overview' ? '/admin' : `/admin/${k}`} end className={() => (current === k ? 'active' : '')}>{label}</NavLink>
        ))}
      </nav>
      {current === 'overview' && <Overview />}
      {current === 'products' && <Products />}
      {current === 'orders' && <Orders />}
      {current === 'customers' && <Customers />}
      {current === 'connectors' && <SapConnectors />}
      {current === 'file-transfer' && <FileTransfer />}
      {current === 'suppliers' && <Suppliers />}
    </div>
  );
}
