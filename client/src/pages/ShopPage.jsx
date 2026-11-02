import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, dateTime, money } from '../api.js';
import { useAuth, useCart } from '../state.jsx';
import { useToast } from '../components/Toast.jsx';
import ProductArt, { BikeArt } from '../components/ProductArt.jsx';
import { DatabaseIcon, ReturnIcon, SearchIcon, ShieldIcon, TruckIcon } from '../components/Icons.jsx';

const CATEGORY_ORDER = ['Bikes', 'E-Bikes', 'Accessories', 'Apparel', 'Other'];
const SORTS = {
  featured: { label: 'Featured', fn: (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.name.localeCompare(b.name) },
  priceAsc: { label: 'Price: low to high', fn: (a, b) => a.price - b.price },
  priceDesc: { label: 'Price: high to low', fn: (a, b) => b.price - a.price },
  name: { label: 'Name A–Z', fn: (a, b) => a.name.localeCompare(b.name) },
};

export function StockBadge({ stock }) {
  if (stock <= 0) return <span className="stock out">Out of stock</span>;
  if (stock <= 5) return <span className="stock low">Only {stock} left</span>;
  return <span className="stock in">In stock</span>;
}

function ProductCard({ product }) {
  const { add, items } = useCart();
  const toast = useToast();
  const inCart = items.find(i => i.product.id === product.id)?.quantity || 0;
  const available = product.stock - inCart;

  const addToCart = e => {
    e.preventDefault();
    add(product, 1);
    toast(`${product.name} added to your cart`, 'success');
  };

  return (
    <Link to={`/products/${product.id}`} className="product-card">
      <ProductArt product={product} />
      <div className="product-body">
        <div className="product-meta">
          <span className="category-label">{product.category}</span>
          <StockBadge stock={product.stock} />
        </div>
        <h3>{product.name}</h3>
        <p className="desc">{product.description || 'No description available.'}</p>
        <div className="product-foot">
          <span className="price">{money(product.price, product.currency)}</span>
          <button className="primary small-btn" disabled={available <= 0} onClick={addToCart}>
            {product.stock <= 0 ? 'Sold out' : available <= 0 ? 'In cart' : 'Add to cart'}
          </button>
        </div>
      </div>
    </Link>
  );
}

function EmptyShop({ erp }) {
  const { user } = useAuth();
  const down = erp?.configured && erp.lastSync?.ok === false;
  const local = /localhost|127\.0\.0\.1/.test(erp?.connector?.url || '');
  if (erp?.integration === 'file') return (
    <div className="empty">
      <span className="empty-icon"><DatabaseIcon /></span>
      <strong>No product file has been imported yet.</strong>
      <span>The catalog arrives as a file from the SAP ERP. Please try again in a minute.</span>
      {user?.role === 'admin' && <Link to="/admin/file-transfer" className="button">Open File transfer</Link>}
    </div>
  );
  if (!down) return <div className="empty">No products available yet.</div>;
  return (
    <div className="empty">
      <span className="empty-icon"><DatabaseIcon /></span>
      <strong>Our product catalog is not available right now.</strong>
      <span>The shop gets its products live from the SAP ERP, which cannot be reached at the moment. Please try again in a minute.</span>
      {user?.role === 'admin' && (
        <div className="admin-hint">
          <span><strong>{erp.connector.name}:</strong> {erp.lastSync.error}</span>
          <span>{local ? <>Start the Mini-ERP with <code>cds watch</code>, then reload this page.</> : <>Start the ERP app and HANA Cloud in the SAP BTP cockpit.</>}</span>
          <Link to="/admin/connectors" className="button">Open SAP connectors</Link>
        </div>
      )}
      <button onClick={() => location.reload()}>Try again</button>
    </div>
  );
}

export default function ShopPage() {
  const [products, setProducts] = useState(null);
  const [erp, setErp] = useState(null);
  const [error, setError] = useState('');
  const [category, setCategory] = useState('All');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('featured');
  const [inStockOnly, setInStockOnly] = useState(false);

  useEffect(() => {
    api.products().then(setProducts).catch(e => setError(e.message));
    api.erpStatus().then(setErp).catch(() => {});
  }, []);

  const categories = useMemo(() => {
    const present = new Set((products || []).map(p => p.category));
    return ['All', ...CATEGORY_ORDER.filter(c => present.has(c))];
  }, [products]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (products || [])
      .filter(p => category === 'All' || p.category === category)
      .filter(p => !inStockOnly || p.stock > 0)
      .filter(p => !q || `${p.name} ${p.productId} ${p.description} ${p.category}`.toLowerCase().includes(q))
      .sort(SORTS[sort].fn);
  }, [products, category, query, sort, inStockOnly]);

  const countFor = c => (products || []).filter(p => c === 'All' || p.category === c).length;

  return (
    <>
      <section className="hero-banner">
        <div className="container hero-inner">
          <div className="hero-copy">
            <span className="eyebrow">New season 2026</span>
            <h1>Ride further.<br />Ride better.</h1>
            <p>Bikes, e-bikes and gear with {erp?.integration === 'file' ? 'stock from our ERP, delivered by file transfer' : 'live stock straight from our ERP'}. Order today, ships tomorrow.</p>
            <div className="hero-cta">
              <a href="#catalog" className="button primary large">Shop now</a>
              {erp?.configured && (
                <span className="live-pill" title={erp.connector.url}>
                  <span className={`dot ${erp.lastSync?.ok === false ? 'bad' : 'good'}`} />
                  {erp.integration === 'file'
                    ? `Catalog from ${erp.connector.name} · file transfer${erp.lastSync?.at ? `, ${dateTime(erp.lastSync.at)}` : ''}`
                    : erp.lastSync?.ok === false ? `${erp.connector.name} offline` : `Live stock from ${erp.connector.name}`}
                </span>
              )}
            </div>
          </div>
          <div className="hero-art" aria-hidden="true">
            <svg viewBox="0 0 120 84"><BikeArt /></svg>
          </div>
        </div>
      </section>

      <div className="container">
        <div className="perks">
          <div><TruckIcon /><span><strong>Free shipping</strong><small>on every order</small></span></div>
          <div><ReturnIcon /><span><strong>30-day returns</strong><small>no questions asked</small></span></div>
          <div><ShieldIcon /><span><strong>Secure checkout</strong><small>hashed passwords, sessions</small></span></div>
          <div><DatabaseIcon /><span><strong>ERP integrated</strong><small>orders go straight to the ERP</small></span></div>
        </div>

        <section id="catalog" className="catalog">
          <div className="catalog-head">
            <div>
              <h2>{category === 'All' ? 'All products' : category}</h2>
              <p className="muted small">{visible.length} of {products?.length ?? 0} products</p>
            </div>
            <div className="toolbar">
              <div className="search-box">
                <SearchIcon />
                <input type="search" placeholder="Search products" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search products" />
              </div>
              <select value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort products">
                {Object.entries(SORTS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
              </select>
              <label className="check"><input type="checkbox" checked={inStockOnly} onChange={e => setInStockOnly(e.target.checked)} /> In stock only</label>
            </div>
          </div>

          <div className="chips">
            {categories.map(c => (
              <button key={c} className={`chip ${category === c ? 'active' : ''}`} onClick={() => setCategory(c)}>
                {c} <span>{countFor(c)}</span>
              </button>
            ))}
          </div>

          {error && <p className="error">{error}</p>}
          {products === null && !error && (
            <div className="grid">{[1, 2, 3, 4].map(i => <div key={i} className="product-card skeleton" />)}</div>
          )}
          {products?.length === 0 && <EmptyShop erp={erp} />}
          {products?.length > 0 && visible.length === 0 && <div className="empty">No products match your filters.</div>}

          <div className="grid">
            {visible.map(p => <ProductCard key={p.id} product={p} />)}
          </div>
        </section>
      </div>
    </>
  );
}
