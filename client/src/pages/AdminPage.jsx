// AdminPage.jsx - the admin area (/admin/:tab, admins only): Overview (key figures), Products, Orders, Customers,
// SAP connectors, File transfer (Lab 2) and Suppliers (Lab 2 extension). The last three tabs are separate components.
//
// React hooks: effect (loading), memo, state.
import { useEffect, useMemo, useState } from 'react';
// Router: links, active-aware links and the :tab parameter.
import { Link, NavLink, useParams } from 'react-router-dom';
// API calls and formatting.
import { api, dateOnly, dateTime, money } from '../api.js';
// Notifications.
import { useToast } from '../components/Toast.jsx';
// Dialog window (product form).
import Modal from '../components/Modal.jsx';
// Product pictures.
import ProductArt from '../components/ProductArt.jsx';
// Order cards, status list and status label.
import OrderCard, { STATUSES, StatusBadge } from '../components/OrderCard.jsx';
// Tab: SAP connectors (which ERP the shop uses).
import SapConnectors from '../components/SapConnectors.jsx';
// Tab: file transfer (Lab 2).
import FileTransfer from '../components/FileTransfer.jsx';
// Tab: suppliers (Lab 2 extension).
import Suppliers from '../components/Suppliers.jsx';

// Shop categories for the product form (the category is shop data, not ERP data).
const CATEGORIES = ['Bikes', 'E-Bikes', 'Accessories', 'Apparel', 'Other'];

/* ---------------- Overview ---------------- */
// Overview tab: key figures, orders by status, low stock and the latest orders.
function Overview() {
  // Figures from GET /api/admin/stats.
  const [stats, setStats] = useState(null);
  // The five newest orders.
  const [orders, setOrders] = useState([]);
  // Load both once when the tab opens.
  useEffect(() => {
    // Key figures.
    api.stats().then(setStats).catch(() => {});
    // All orders (admin), keep the newest five.
    api.orders(true).then(o => setOrders(o.slice(0, 5))).catch(() => {});
  }, []);
  // Still loading.
  if (!stats) return <p className="muted">Loading…</p>;
  // Largest status count (scales the bars; at least 1 to avoid a division by zero).
  const maxStatus = Math.max(1, ...Object.values(stats.byStatus));

  // The tab markup.
  return (
    // Vertical stack of the sections.
    <div className="stack">
      {/* Four key figure tiles. */}
      <div className="kpis">
        {/* Revenue (without canceled orders). */}
        <div className="kpi"><span className="kpi-label">Revenue</span><span className="kpi-value">{money(stats.revenue)}</span><span className="kpi-sub">excl. canceled orders</span></div>
        {/* Orders: total, open, and how many exist in the SAP ERP. */}
        <div className="kpi"><span className="kpi-label">Orders</span><span className="kpi-value">{stats.orders}</span><span className="kpi-sub">{stats.openOrders} open · {stats.ordersInErp} in SAP ERP</span></div>
        {/* Registered customers. */}
        <div className="kpi"><span className="kpi-label">Customers</span><span className="kpi-value">{stats.customers}</span><span className="kpi-sub">registered accounts</span></div>
        {/* Products and how many are low on stock. */}
        <div className="kpi"><span className="kpi-label">Products</span><span className="kpi-value">{stats.products}</span><span className="kpi-sub">{stats.lowStock.length} low on stock</span></div>
      </div>

      {/* Two equal columns. */}
      <div className="two-col even">
        {/* Orders by status. */}
        <section className="card">
          {/* Title. */}
          <h3>Orders by status</h3>
          {/* No orders yet. */}
          {stats.orders === 0 && <p className="muted small">No orders yet.</p>}
          {/* Bar chart as a list. */}
          <ul className="bars">
            {/* One bar per status that occurs. */}
            {STATUSES.filter(s => stats.byStatus[s]).map(s => (
              // One bar; the tooltip shows the exact number.
              <li key={s} title={`${s}: ${stats.byStatus[s]} orders`}>
                {/* Status in normal case. */}
                <span className="bar-label">{s.charAt(0) + s.slice(1).toLowerCase()}</span>
                {/* Bar length relative to the largest status. */}
                <span className="bar-track"><span className="bar-fill" style={{ width: `${(stats.byStatus[s] / maxStatus) * 100}%` }} /></span>
                {/* Number. */}
                <span className="bar-value">{stats.byStatus[s]}</span>
              </li>
            ))}
          </ul>
        </section>
        {/* Low stock. */}
        <section className="card">
          {/* Title. */}
          <h3>Low stock</h3>
          {/* Nothing low. */}
          {stats.lowStock.length === 0 && <p className="muted small">All products have enough stock.</p>}
          {/* Product list. */}
          <ul className="simple-list">
            {/* One line per product with 5 or fewer items. */}
            {stats.lowStock.map(p => (
              // Name and product ID.
              <li key={p.id}><span>{p.name} <span className="muted small">{p.productId}</span></span>
                {/* Stock label. */}
                <span className={`stock ${p.stock === 0 ? 'out' : 'low'}`}>{p.stock === 0 ? 'Out of stock' : `${p.stock} left`}</span></li>
            ))}
          </ul>
        </section>
      </div>

      {/* Latest orders. */}
      <section className="card">
        {/* Title and link to all orders. */}
        <div className="section-head"><h3>Latest orders</h3><Link to="/admin/orders">All orders</Link></div>
        {/* Table or a short message. */}
        {orders.length === 0 ? <p className="muted small">No orders yet.</p> : (
          // Table of the five newest orders.
          <table className="table">
            {/* Column titles. */}
            <thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Status</th><th className="right">Total</th></tr></thead>
            {/* Rows. */}
            <tbody>
              {/* One row per order. */}
              {orders.map(o => (
                // One row.
                <tr key={o.id}>
                  {/* Order number and ERP number. */}
                  <td>#{o.id}{o.erpOrderNumber && <span className="tag erp">ERP #{o.erpOrderNumber}</span>}</td>
                  {/* Customer and date. */}
                  <td>{o.customer.name}</td><td>{dateTime(o.orderDate)}</td>
                  {/* Status and total. */}
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

/* ---------------- Products ---------------- */
// An empty product (form for a new product).
const EMPTY_PRODUCT = { productId: '', name: '', description: '', price: '', stock: '0', category: 'Bikes' };

// Dialog to create or edit a product. fileMode: the ERP fields are read-only (they come with the export file).
function ProductForm({ initial, erpOn, fileMode, onClose, onSaved }) {
  // Notifications.
  const toast = useToast();
  // No id = new product.
  const isNew = !initial.id;
  // Form values as text (inputs work with strings).
  const [form, setForm] = useState({ ...EMPTY_PRODUCT, ...initial, price: String(initial.price ?? ''), stock: String(initial.stock ?? '0') });
  // true while saving.
  const [busy, setBusy] = useState(false);
  // Error message from the server or the ERP.
  const [error, setError] = useState('');
  // Change handler for one field.
  const set = k => e => setForm({ ...form, [k]: e.target.value });

  // Saves the product (the server writes it to the ERP first when one is connected).
  const save = async () => {
    // Disable the buttons.
    setBusy(true);
    // Clear the old error.
    setError('');
    try {
      // The fields the server accepts (the product ID only for new products).
      const body = { name: form.name, description: form.description, price: form.price, stock: form.stock, category: form.category };
      // New: POST /api/products.
      if (isNew) await api.addProduct({ ...body, productId: form.productId });
      // Existing: PUT /api/products/:id.
      else await api.updateProduct(initial.id, body);
      // Confirmation.
      toast(isNew ? `${form.name} created` : `${form.name} saved`, 'success');
      // Tell the parent (closes the dialog and reloads the list).
      onSaved();
    } catch (e) {
      // Show the error in the dialog (e.g. the ERP refused the value).
      setError(e.message);
    } finally {
      // Enable the buttons again.
      setBusy(false);
    }
  };

  // The dialog markup.
  return (
    // Dialog with a title and Cancel / Save buttons in the footer.
    <Modal title={isNew ? 'New product' : `Edit ${initial.name}`} onClose={onClose}
           footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}>
      {/* Form grid. */}
      <div className="form-grid">
        {/* Product ID (only for new products; it is the key in the ERP). */}
        <label>Product ID<input value={form.productId} onChange={set('productId')} disabled={!isNew} placeholder="e.g. DXTR2000" /></label>
        {/* Category select box. */}
        <label>Category
          {/* One option per category. */}
          <select value={form.category} onChange={set('category')}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select>
        </label>
        {/* Name. */}
        <label className="span-all">Name<input value={form.name} onChange={set('name')} disabled={fileMode} /></label>
        {/* Description. */}
        <label className="span-all">Description<textarea rows="3" value={form.description} onChange={set('description')} disabled={fileMode} /></label>
        {/* Price in EUR. */}
        <label>Price (EUR)<input type="number" min="0" step="0.01" value={form.price} onChange={set('price')} disabled={fileMode} /></label>
        {/* Stock (0-1000, the ERP's limit). */}
        <label>Stock<input type="number" min="0" max="1000" step="1" value={form.stock} onChange={set('stock')} disabled={fileMode} /></label>
      </div>
      {/* Hint: file mode (ERP fields read-only) or ERP mode (saved in the ERP first). */}
      {fileMode
        ? <p className="muted small">File transfer mode: name, description, price and stock come from the ERP's export file and can only be changed in the ERP. The category is shop data.</p>
        : erpOn && <p className="muted small">Saved in the SAP ERP of the active connector first; the shop takes over the ERP data.</p>}
      {/* Error message. */}
      {error && <p className="error small">{error}</p>}
    </Modal>
  );
}

// Products tab: table of all products with search, removed filter, edit and remove/restore.
function Products() {
  // Notifications.
  const toast = useToast();
  // All products including removed ones (null while loading).
  const [products, setProducts] = useState(null);
  // Search text.
  const [query, setQuery] = useState('');
  // Also show removed products.
  const [showRemoved, setShowRemoved] = useState(false);
  // Product in the dialog (null = closed).
  const [editing, setEditing] = useState(null);
  // ERP status (mode hints).
  const [erp, setErp] = useState(null);

  // Loads the product list (GET /api/products?all=true).
  const load = () => api.products(true).then(setProducts).catch(e => toast(e.message, 'error'));
  // Load products and ERP status when the tab opens.
  useEffect(() => { load(); api.erpStatus().then(setErp).catch(() => {}); }, []);
  // An ERP connector is active.
  const erpOn = !!erp?.configured;
  // The active connector uses file transfer (Lab 2).
  const fileMode = erp?.integration === 'file';

  // Removes a product from the shop (soft delete) or restores it.
  const toggle = async p => {
    try {
      // Active product: remove.
      if (p.active) {
        // Ask first.
        if (!confirm(`Remove "${p.name}" from the shop? It stays in the ERP and can be restored.`)) return;
        // DELETE /api/products/:id (sets active = 0; the product stays in the ERP).
        await api.removeProduct(p.id);
        // Message.
        toast(`${p.name} removed from the shop`, 'info');
      } else {
        // Removed product: restore (active = true).
        await api.updateProduct(p.id, { active: true });
        // Message.
        toast(`${p.name} restored`, 'success');
      }
      // Reload the list.
      load();
    } catch (e) {
      // Error message.
      toast(e.message, 'error');
    }
  };

  // The rows shown.
  const visible = (products || [])
    // Hide removed products unless wanted.
    .filter(p => showRemoved || p.active)
    // Search in name, product ID and category.
    .filter(p => !query || `${p.name} ${p.productId} ${p.category}`.toLowerCase().includes(query.toLowerCase()));

  // The tab markup.
  return (
    // Card.
    <section className="card">
      {/* Head: title, source and toolbar. */}
      <div className="section-head">
        {/* Title part. */}
        <div>
          {/* Title with the number of rows. */}
          <h3>Products <span className="muted">({visible.length})</span></h3>
          {/* Where the products come from. */}
          <p className="muted small">
            {/* File transfer, ERP via API, or standalone. */}
            {fileMode ? <>From <Link to="/admin/file-transfer">{erp.connector.name} via file transfer</Link> – master data is changed in the ERP and arrives with the next file.</>
              : erpOn ? <>From <Link to="/admin/connectors">{erp.connector.name}</Link> – changes are saved in that ERP first.</>
              : 'Standalone mode – products and stock are kept in the shop only.'}
          </p>
        </div>
        {/* Toolbar. */}
        <div className="toolbar">
          {/* Search. */}
          <input type="search" placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search products" />
          {/* Show removed products. */}
          <label className="check"><input type="checkbox" checked={showRemoved} onChange={e => setShowRemoved(e.target.checked)} /> Show removed</label>
          {/* New product (not in file mode: new products are created in the ERP there). */}
          <button className="primary" disabled={fileMode} title={fileMode ? 'In file transfer mode new products are created in the ERP' : ''}
                  onClick={() => setEditing({ ...EMPTY_PRODUCT })}>New product</button>
        </div>
      </div>
      {/* Scrollable table on small screens. */}
      <div className="table-wrap">
        {/* Product table. */}
        <table className="table">
          {/* Column titles. */}
          <thead><tr><th>Product</th><th>Category</th><th className="right">Price</th><th className="right">Stock</th><th>Source</th><th /></tr></thead>
          {/* Rows. */}
          <tbody>
            {/* One row per product. */}
            {visible.map(p => (
              // Row (greyed out when removed).
              <tr key={p.id} className={p.active ? '' : 'inactive'}>
                {/* Product cell. */}
                <td>
                  {/* Picture and name. */}
                  <div className="cell-product">
                    {/* Mini picture. */}
                    <ProductArt product={p} size="mini" />
                    {/* Name and product ID. */}
                    <span><strong>{p.name}</strong><span className="muted small">{p.productId}</span></span>
                  </div>
                </td>
                {/* Category. */}
                <td>{p.category}</td>
                {/* Price. */}
                <td className="right">{money(p.price, p.currency)}</td>
                {/* Stock with color. */}
                <td className="right"><span className={`stock ${p.stock === 0 ? 'out' : p.stock <= 5 ? 'low' : 'in'}`}>{p.stock}</span></td>
                {/* Source cell. */}
                <td>
                  {/* SAP ERP (API or file) or shop-only product. */}
                  {p.erpManaged ? <span className="tag erp">{p.erpSource === 'file' ? 'SAP ERP · file' : 'SAP ERP'}</span> : <span className="tag">Shop</span>}
                  {/* Removed label. */}
                  {!p.active && <span className="tag">removed</span>}
                  {/* Whether the product came with the ERP's initial data or was added through the API. */}
                  {p.erpManaged && p.erpCreatedBy !== null && (
                    // Note with a tooltip (createdBy in the ERP).
                    <span className="source-note" title={p.erpCreatedBy ? `createdBy in the ERP: ${p.erpCreatedBy}` : 'loaded with the ERP data (CSV)'}>
                      {/* Text of the note. */}
                      {p.erpCreatedBy ? 'added via API' : 'ERP initial data'}
                    </span>
                  )}
                </td>
                {/* Actions. */}
                <td className="right nowrap">
                  {/* Edit. */}
                  <button className="link" onClick={() => setEditing(p)}>Edit</button>
                  {/* Remove or restore. */}
                  <button className={`link ${p.active ? 'danger' : ''}`} onClick={() => toggle(p)}>{p.active ? 'Remove' : 'Restore'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* No products at all. */}
      {products?.length === 0 && (
        // Empty state.
        <div className="empty">
          {/* With an ERP: name and the last error, and a link to the connectors; otherwise a short text. */}
          {erpOn ? <>No products from {erp.connector.name} yet{erp.lastSync?.ok === false ? ` – ${erp.lastSync.error}` : ''}.
            <Link to="/admin/connectors" className="button">Open SAP connectors</Link></> : 'No products yet.'}
        </div>
      )}
      {/* The product dialog, if open; after saving it closes and the list is reloaded. */}
      {editing && <ProductForm initial={editing} erpOn={erpOn} fileMode={fileMode && !!editing.id} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </section>
  );
}

/* ---------------- Orders ---------------- */
// Orders tab: all orders with a status filter; the cards let the admin change the status.
function Orders() {
  // All orders (null while loading).
  const [orders, setOrders] = useState(null);
  // Selected status filter.
  const [filter, setFilter] = useState('ALL');
  // Load all orders once (GET /api/orders?all=true).
  useEffect(() => { api.orders(true).then(setOrders).catch(() => setOrders([])); }, []);
  // Replaces one order after a status change.
  const replace = updated => setOrders(list => list.map(o => (o.id === updated.id ? updated : o)));
  // Number of orders per filter.
  const count = f => (orders || []).filter(o => f === 'ALL' || o.status === f).length;
  // Still loading.
  if (orders === null) return <p className="muted">Loading…</p>;
  // The tab markup.
  return (
    // Fragment.
    <>
      {/* Filter chips. */}
      <div className="chips">
        {/* All plus every status. */}
        {['ALL', ...STATUSES].map(f => (
          // Chip button.
          <button key={f} className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
            {/* Label and number. */}
            {f === 'ALL' ? 'All' : f.charAt(0) + f.slice(1).toLowerCase()} <span>{count(f)}</span>
          </button>
        ))}
      </div>
      {/* No orders yet. */}
      {orders.length === 0 && <div className="empty">No orders yet.</div>}
      {/* Order cards. */}
      <div className="stack">
        {/* Filtered orders, admin view (status select, customer shown). */}
        {orders.filter(o => filter === 'ALL' || o.status === filter)
          .map(o => <OrderCard key={o.id} order={o} isAdmin showCustomer onChange={replace} />)}
      </div>
    </>
  );
}

/* ---------------- Customers ---------------- */
// Customers tab: all accounts with their order statistics.
function Customers() {
  // Customer list (null while loading).
  const [customers, setCustomers] = useState(null);
  // Load once (GET /api/admin/customers).
  useEffect(() => { api.customers().then(setCustomers).catch(() => setCustomers([])); }, []);
  // Still loading.
  if (customers === null) return <p className="muted">Loading…</p>;
  // The tab markup.
  return (
    // Card.
    <section className="card">
      {/* Title with the number of customers (admins not counted). */}
      <h3>Customers <span className="muted">({customers.filter(c => c.role === 'customer').length})</span></h3>
      {/* Scrollable table. */}
      <div className="table-wrap">
        {/* Customer table. */}
        <table className="table">
          {/* Column titles. */}
          <thead><tr><th>Name</th><th>E-mail</th><th>City</th><th>Since</th><th className="right">Orders</th><th className="right">Spent</th><th>ERP</th></tr></thead>
          {/* Rows. */}
          <tbody>
            {/* One row per account. */}
            {customers.map(c => (
              // One row.
              <tr key={c.id}>
                {/* Name and admin label. */}
                <td><strong>{c.name}</strong>{c.role === 'admin' && <span className="tag">admin</span>}</td>
                {/* E-mail, city and registration date. */}
                <td>{c.email}</td><td>{c.city || '–'}</td><td>{dateOnly(c.memberSince)}</td>
                {/* Number of orders and money spent. */}
                <td className="right">{c.orders}</td><td className="right">{money(c.spent)}</td>
                {/* Whether the customer is linked to a customer in the ERP. */}
                <td>{c.erpCustomer ? <span className="tag erp">linked</span> : <span className="muted small">–</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// The tabs: URL part and label.
const TABS = [
  // Lab 1 tabs.
  ['overview', 'Overview'], ['products', 'Products'], ['orders', 'Orders'], ['customers', 'Customers'], ['connectors', 'SAP connectors'],
  // Lab 2 tabs.
  ['file-transfer', 'File transfer'], ['suppliers', 'Suppliers'],
];

/** Which ERP the shop is connected to - shown in the admin header, links to the connectors tab. */
// Props: the current tab (the status is loaded again when the tab changes).
function ConnectionChip({ tab }) {
  // ERP status (GET /api/erp/status).
  const [status, setStatus] = useState(null);
  // Load now and whenever a connector changes.
  useEffect(() => {
    // Loads the status.
    const load = () => api.erpStatus().then(setStatus).catch(() => {});
    // Now.
    load();
    // SapConnectors.jsx sends this event after a switch.
    window.addEventListener('sap-connector-changed', load);
    // Cleanup: remove the listener.
    return () => window.removeEventListener('sap-connector-changed', load);
  // Again when the tab changes.
  }, [tab]);
  // Not loaded yet: show nothing.
  if (!status) return null;
  // The active connector (or null).
  const c = status.connector;
  // Dot color: idle (none / not synced yet), bad (last sync failed) or good.
  const state = !c ? 'idle' : status.lastSync?.ok === false ? 'bad' : status.lastSync?.ok ? 'good' : 'idle';
  // The chip markup.
  return (
    // Chip = link to the connectors tab.
    <Link to="/admin/connectors" className="connection-chip" title="Change in SAP connectors">
      {/* Colored dot. */}
      <span className={`dot ${state}`} />
      {/* Label (with file transfer note) and the connector name, or standalone. */}
      <span><small>SAP connector{c?.integration === 'file' ? ' · file transfer' : ''}</small>{c ? c.name : 'none (standalone)'}</span>
    </Link>
  );
}

// The admin page.
export default function AdminPage() {
  // Tab from the URL, overview by default.
  const { tab = 'overview' } = useParams();
  // Valid tab (the old name 'erp' = connectors; unknown tabs = overview).
  const current = useMemo(() => (tab === 'erp' ? 'connectors' : TABS.some(([k]) => k === tab) ? tab : 'overview'), [tab]);
  // The page markup.
  return (
    // Centered width.
    <div className="container">
      {/* Head: title and connection chip. */}
      <div className="admin-head">
        {/* Title part. */}
        <div>
          {/* Title. */}
          <h1 className="page-title">Admin</h1>
          {/* Sub title. */}
          <p className="muted">Manage products, orders and customers. Product and order data live in the SAP ERP.</p>
        </div>
        {/* Which ERP is connected. */}
        <ConnectionChip tab={current} />
      </div>
      {/* Tab navigation. */}
      <nav className="tabs">
        {/* One link per tab. */}
        {TABS.map(([k, label]) => (
          // Tab link (highlighted when it is the current tab).
          <NavLink key={k} to={k === 'overview' ? '/admin' : `/admin/${k}`} end className={() => (current === k ? 'active' : '')}>{label}</NavLink>
        ))}
      </nav>
      {/* Overview. */}
      {current === 'overview' && <Overview />}
      {/* Products. */}
      {current === 'products' && <Products />}
      {/* Orders. */}
      {current === 'orders' && <Orders />}
      {/* Customers. */}
      {current === 'customers' && <Customers />}
      {/* SAP connectors. */}
      {current === 'connectors' && <SapConnectors />}
      {/* File transfer. */}
      {current === 'file-transfer' && <FileTransfer />}
      {/* Suppliers. */}
      {current === 'suppliers' && <Suppliers />}
    </div>
  );
}
