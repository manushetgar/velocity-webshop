// ShopPage.jsx - the start page (/): banner, shop benefits and the product catalog with category chips, search,
// sorting and an in-stock filter. The products come from GET /api/products (a copy of the ERP's products).
//
// React hooks: effect (loading), memo (filtered list), state (filters).
import { useEffect, useMemo, useState } from 'react';
// Router link.
import { Link } from 'react-router-dom';
// API calls and formatting.
import { api, dateTime, money } from '../api.js';
// Login state (admin hints) and cart.
import { useAuth, useCart } from '../state.jsx';
// Notifications.
import { useToast } from '../components/Toast.jsx';
// Product pictures and the bike drawing of the banner.
import ProductArt, { BikeArt } from '../components/ProductArt.jsx';
// Icons.
import { DatabaseIcon, ReturnIcon, SearchIcon, ShieldIcon, TruckIcon } from '../components/Icons.jsx';

// Order of the categories in the chips and in the 'Featured' sorting.
const CATEGORY_ORDER = ['Bikes', 'E-Bikes', 'Accessories', 'Apparel', 'Other'];
// Sort options: label for the select box and the compare function for Array.sort().
const SORTS = {
  // Featured: by category order, then by name.
  featured: { label: 'Featured', fn: (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.name.localeCompare(b.name) },
  // Cheapest first.
  priceAsc: { label: 'Price: low to high', fn: (a, b) => a.price - b.price },
  // Most expensive first.
  priceDesc: { label: 'Price: high to low', fn: (a, b) => b.price - a.price },
  // Alphabetical.
  name: { label: 'Name A–Z', fn: (a, b) => a.name.localeCompare(b.name) },
};

// Stock label: out of stock, only a few left (5 or less), or in stock.
export function StockBadge({ stock }) {
  // Nothing left.
  if (stock <= 0) return <span className="stock out">Out of stock</span>;
  // Low stock: show the exact number.
  if (stock <= 5) return <span className="stock low">Only {stock} left</span>;
  // Enough stock.
  return <span className="stock in">In stock</span>;
}

// One product card in the grid (the whole card links to the product page).
function ProductCard({ product }) {
  // Cart actions and items.
  const { add, items } = useCart();
  // Notifications.
  const toast = useToast();
  // How many of this product are already in the cart.
  const inCart = items.find(i => i.product.id === product.id)?.quantity || 0;
  // How many more can be added.
  const available = product.stock - inCart;

  // The card's 'Add to cart' button.
  const addToCart = e => {
    // The button is inside the link: do not open the product page.
    e.preventDefault();
    // Add one item.
    add(product, 1);
    // Confirmation.
    toast(`${product.name} added to your cart`, 'success');
  };

  // The card markup.
  return (
    // Card = link to the product page.
    <Link to={`/products/${product.id}`} className="product-card">
      {/* Picture. */}
      <ProductArt product={product} />
      {/* Text part. */}
      <div className="product-body">
        {/* Category and stock. */}
        <div className="product-meta">
          {/* Category. */}
          <span className="category-label">{product.category}</span>
          {/* Stock label. */}
          <StockBadge stock={product.stock} />
        </div>
        {/* Product name. */}
        <h3>{product.name}</h3>
        {/* Description (shortened by CSS). */}
        <p className="desc">{product.description || 'No description available.'}</p>
        {/* Price and button. */}
        <div className="product-foot">
          {/* Price. */}
          <span className="price">{money(product.price, product.currency)}</span>
          {/* Add to cart (disabled when nothing is available). */}
          <button className="primary small-btn" disabled={available <= 0} onClick={addToCart}>
            {/* Button text: sold out, everything in the cart, or add. */}
            {product.stock <= 0 ? 'Sold out' : available <= 0 ? 'In cart' : 'Add to cart'}
          </button>
        </div>
      </div>
    </Link>
  );
}

/** Shop without products: usually the ERP of the active SAP connector is not running. */
// Props: the ERP status (GET /api/erp/status).
function EmptyShop({ erp }) {
  // Logged-in user (admins get a hint what to do).
  const { user } = useAuth();
  // The ERP is configured, but the last sync failed.
  const down = erp?.configured && erp.lastSync?.ok === false;
  // The active connector points to this computer (local Mini-ERP).
  const local = /localhost|127\.0\.0\.1/.test(erp?.connector?.url || '');
  // File transfer (Lab 2): the catalog appears when the first product file from the ERP has been imported.
  // File transfer mode, no file imported yet.
  if (erp?.integration === 'file') return (
    // Message box.
    <div className="empty">
      {/* Icon. */}
      <span className="empty-icon"><DatabaseIcon /></span>
      {/* Headline. */}
      <strong>No product file has been imported yet.</strong>
      {/* Explanation for customers. */}
      <span>The catalog arrives as a file from the SAP ERP. Please try again in a minute.</span>
      {/* Admins: link to the file transfer page. */}
      {user?.role === 'admin' && <Link to="/admin/file-transfer" className="button">Open File transfer</Link>}
    </div>
  );
  // No products, but the ERP is fine: simple message.
  if (!down) return <div className="empty">No products available yet.</div>;
  // The ERP cannot be reached.
  return (
    // Message box.
    <div className="empty">
      {/* Icon. */}
      <span className="empty-icon"><DatabaseIcon /></span>
      {/* Headline. */}
      <strong>Our product catalog is not available right now.</strong>
      {/* Explanation for customers. */}
      <span>The shop gets its products live from the SAP ERP, which cannot be reached at the moment. Please try again in a minute.</span>
      {/* Admins: the error and what to start. */}
      {user?.role === 'admin' && (
        // Hint box.
        <div className="admin-hint">
          {/* Connector name and the error of the last sync. */}
          <span><strong>{erp.connector.name}:</strong> {erp.lastSync.error}</span>
          {/* Local ERP: start cds watch; BTP: start the app and HANA in the cockpit. */}
          <span>{local ? <>Start the Mini-ERP with <code>cds watch</code>, then reload this page.</> : <>Start the ERP app and HANA Cloud in the SAP BTP cockpit.</>}</span>
          {/* Link to the SAP connectors. */}
          <Link to="/admin/connectors" className="button">Open SAP connectors</Link>
        </div>
      )}
      {/* Reload the page. */}
      <button onClick={() => location.reload()}>Try again</button>
    </div>
  );
}

// The start page.
export default function ShopPage() {
  // The products (null while loading).
  const [products, setProducts] = useState(null);
  // ERP status for the banner and the empty state.
  const [erp, setErp] = useState(null);
  // Error message of the product request.
  const [error, setError] = useState('');
  // Selected category chip.
  const [category, setCategory] = useState('All');
  // Search text.
  const [query, setQuery] = useState('');
  // Selected sorting.
  const [sort, setSort] = useState('featured');
  // In-stock filter.
  const [inStockOnly, setInStockOnly] = useState(false);

  // Load products and ERP status once when the page opens.
  useEffect(() => {
    // GET /api/products.
    api.products().then(setProducts).catch(e => setError(e.message));
    // GET /api/erp/status (errors are ignored: the banner simply shows no ERP pill).
    api.erpStatus().then(setErp).catch(() => {});
  }, []);

  // Category chips: All plus the categories that actually occur, in the fixed order.
  const categories = useMemo(() => {
    // Categories of the loaded products.
    const present = new Set((products || []).map(p => p.category));
    // All + known categories that occur.
    return ['All', ...CATEGORY_ORDER.filter(c => present.has(c))];
  // Computed again only when the products change.
  }, [products]);

  // The products shown: filtered by category, stock and search text, then sorted.
  const visible = useMemo(() => {
    // Search text in lower case.
    const q = query.trim().toLowerCase();
    // Start with all products (empty list while loading).
    return (products || [])
      // Category filter.
      .filter(p => category === 'All' || p.category === category)
      // In-stock filter.
      .filter(p => !inStockOnly || p.stock > 0)
      // Search in name, product ID, description and category.
      .filter(p => !q || `${p.name} ${p.productId} ${p.description} ${p.category}`.toLowerCase().includes(q))
      // Sorting.
      .sort(SORTS[sort].fn);
  // Computed again when products or filters change.
  }, [products, category, query, sort, inStockOnly]);

  // Number of products per category (shown in the chips).
  const countFor = c => (products || []).filter(p => c === 'All' || p.category === c).length;

  // The page markup.
  return (
    // Fragment: banner and content.
    <>
      {/* Banner. */}
      <section className="hero-banner">
        {/* Centered width. */}
        <div className="container hero-inner">
          {/* Text part. */}
          <div className="hero-copy">
            {/* Small line above the headline. */}
            <span className="eyebrow">New season 2026</span>
            {/* Headline. */}
            <h1>Ride further.<br />Ride better.</h1>
            {/* Text: stock from the ERP via file transfer or live. */}
            <p>Bikes, e-bikes and gear with {erp?.integration === 'file' ? 'stock from our ERP, delivered by file transfer' : 'live stock straight from our ERP'}. Order today, ships tomorrow.</p>
            {/* Buttons. */}
            <div className="hero-cta">
              {/* Jump to the catalog. */}
              <a href="#catalog" className="button primary large">Shop now</a>
              {/* Pill with the ERP state (only with an ERP connected). */}
              {erp?.configured && (
                // Pill; the tooltip shows the ERP's URL.
                <span className="live-pill" title={erp.connector.url}>
                  {/* Green or red dot. */}
                  <span className={`dot ${erp.lastSync?.ok === false ? 'bad' : 'good'}`} />
                  {/* Text: file transfer with the time of the last file, offline, or live stock. */}
                  {erp.integration === 'file'
                    ? `Catalog from ${erp.connector.name} · file transfer${erp.lastSync?.at ? `, ${dateTime(erp.lastSync.at)}` : ''}`
                    : erp.lastSync?.ok === false ? `${erp.connector.name} offline` : `Live stock from ${erp.connector.name}`}
                </span>
              )}
            </div>
          </div>
          {/* Bike drawing (decorative). */}
          <div className="hero-art" aria-hidden="true">
            {/* Drawing area. */}
            <svg viewBox="0 0 120 84"><BikeArt /></svg>
          </div>
        </div>
      </section>

      {/* Centered width. */}
      <div className="container">
        {/* Shop benefits. */}
        <div className="perks">
          {/* Free shipping. */}
          <div><TruckIcon /><span><strong>Free shipping</strong><small>on every order</small></span></div>
          {/* Returns. */}
          <div><ReturnIcon /><span><strong>30-day returns</strong><small>no questions asked</small></span></div>
          {/* Security. */}
          <div><ShieldIcon /><span><strong>Secure checkout</strong><small>hashed passwords, sessions</small></span></div>
          {/* ERP integration. */}
          <div><DatabaseIcon /><span><strong>ERP integrated</strong><small>orders go straight to the ERP</small></span></div>
        </div>

        {/* Catalog (anchor #catalog for the banner button). */}
        <section id="catalog" className="catalog">
          {/* Head: title, count and toolbar. */}
          <div className="catalog-head">
            {/* Title part. */}
            <div>
              {/* Selected category as title. */}
              <h2>{category === 'All' ? 'All products' : category}</h2>
              {/* Number of products shown. */}
              <p className="muted small">{visible.length} of {products?.length ?? 0} products</p>
            </div>
            {/* Search, sorting and filter. */}
            <div className="toolbar">
              {/* Search field with icon. */}
              <div className="search-box">
                {/* Icon. */}
                <SearchIcon />
                {/* Search input. */}
                <input type="search" placeholder="Search products" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search products" />
              </div>
              {/* Sorting. */}
              <select value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort products">
                {/* One option per sort. */}
                {Object.entries(SORTS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
              </select>
              {/* In-stock filter. */}
              <label className="check"><input type="checkbox" checked={inStockOnly} onChange={e => setInStockOnly(e.target.checked)} /> In stock only</label>
            </div>
          </div>

          {/* Category chips. */}
          <div className="chips">
            {/* One chip per category. */}
            {categories.map(c => (
              // Chip button (highlighted when selected).
              <button key={c} className={`chip ${category === c ? 'active' : ''}`} onClick={() => setCategory(c)}>
                {/* Category name and number of products. */}
                {c} <span>{countFor(c)}</span>
              </button>
            ))}
          </div>

          {/* Error message. */}
          {error && <p className="error">{error}</p>}
          {/* Loading: four grey placeholder cards. */}
          {products === null && !error && (
            // Placeholder grid.
            <div className="grid">{[1, 2, 3, 4].map(i => <div key={i} className="product-card skeleton" />)}</div>
          )}
          {/* No products at all: explanation (ERP down, no file yet ...). */}
          {products?.length === 0 && <EmptyShop erp={erp} />}
          {/* Products exist, but the filters hide all of them. */}
          {products?.length > 0 && visible.length === 0 && <div className="empty">No products match your filters.</div>}

          {/* Product grid. */}
          <div className="grid">
            {/* One card per visible product. */}
            {visible.map(p => <ProductCard key={p.id} product={p} />)}
          </div>
        </section>
      </div>
    </>
  );
}
