// ProductPage.jsx - product details (/products/:id): picture, price, stock, description, quantity and add to cart,
// plus up to three related products of the same category.
//
// React hooks: effect (loading), state.
import { useEffect, useState } from 'react';
// Router: links, navigation and the :id parameter.
import { Link, useNavigate, useParams } from 'react-router-dom';
// API calls and money formatting.
import { api, money } from '../api.js';
// Cart.
import { useCart } from '../state.jsx';
// Notifications.
import { useToast } from '../components/Toast.jsx';
// Product picture.
import ProductArt from '../components/ProductArt.jsx';
// Quantity input.
import QuantityStepper from '../components/QuantityStepper.jsx';
// Icons.
import { ArrowLeftIcon, DatabaseIcon, ReturnIcon, TruckIcon } from '../components/Icons.jsx';
// Stock label (shared with the product list).
import { StockBadge } from './ShopPage.jsx';

// The product page.
export default function ProductPage() {
  // Product id from the URL.
  const { id } = useParams();
  // Navigation (Buy now -> cart).
  const navigate = useNavigate();
  // Cart actions and items (to know how many are already in the cart).
  const { add, items } = useCart();
  // Notifications.
  const toast = useToast();
  // The product (null while loading).
  const [product, setProduct] = useState(null);
  // Related products of the same category.
  const [related, setRelated] = useState([]);
  // Error message (e.g. product not found).
  const [error, setError] = useState('');
  // Chosen quantity.
  const [qty, setQty] = useState(1);

  // Load the product whenever the id in the URL changes.
  useEffect(() => {
    // Show the loading state for the new product.
    setProduct(null);
    // Reset the quantity.
    setQty(1);
    // GET /api/products/:id.
    api.product(id).then(p => {
      // Show the product.
      setProduct(p);
      // Then load all products and keep up to three others of the same category.
      api.products().then(all => setRelated(all.filter(x => x.category === p.category && x.id !== p.id).slice(0, 3)));
    // Not found / error: show the message.
    }).catch(e => setError(e.message));
  // Runs again for another product id.
  }, [id]);

  // Error: message and a link back.
  if (error) return <div className="container"><div className="empty">{error} <Link to="/">Back to the shop</Link></div></div>;
  // Loading: grey placeholder.
  if (!product) return <div className="container"><div className="product-detail skeleton" /></div>;

  // How many of this product are already in the cart.
  const inCart = items.find(i => i.product.id === product.id)?.quantity || 0;
  // How many more can be added (stock minus cart).
  const available = Math.max(0, product.stock - inCart);

  // Adds the chosen quantity to the cart; goToCart = Buy now.
  const addToCart = goToCart => {
    // Add to the cart (state.jsx).
    add(product, qty);
    // Confirmation message.
    toast(`${qty} × ${product.name} added to your cart`, 'success');
    // Reset the quantity.
    setQty(1);
    // Buy now: go to the cart.
    if (goToCart) navigate('/cart');
  };

  // The page markup.
  return (
    // Centered page width.
    <div className="container">
      {/* Back link. */}
      <Link to="/" className="back-link"><ArrowLeftIcon /> Back to the shop</Link>
      {/* Picture and information side by side. */}
      <div className="product-detail">
        {/* Large picture. */}
        <ProductArt product={product} size="large" />
        {/* Information column. */}
        <div className="detail-info">
          {/* Category. */}
          <span className="category-label">{product.category}</span>
          {/* Product name. */}
          <h1>{product.name}</h1>
          {/* Article number and stock. */}
          <div className="detail-meta">
            {/* Product ID (the ERP's productID). */}
            <span className="sku">Article {product.productId}</span>
            {/* Stock label (in stock, only a few left, sold out). */}
            <StockBadge stock={product.stock} />
            {/* Exact number available. */}
            {product.stock > 0 && <span className="muted small">{product.stock} available</span>}
          </div>
          {/* Price. */}
          <p className="detail-price">{money(product.price, product.currency)}<small> incl. VAT</small></p>
          {/* Description (from the ERP). */}
          <p className="detail-desc">{product.description || 'No description available.'}</p>

          {/* Quantity and buttons. */}
          <div className="buy-box">
            {/* Quantity, at most what is still available. */}
            <QuantityStepper value={qty} onChange={setQty} max={Math.max(1, available)} disabled={available === 0} />
            {/* Add to cart. */}
            <button className="primary large grow" disabled={available === 0} onClick={() => addToCart(false)}>
              {/* Button text: sold out, everything already in the cart, or add. */}
              {product.stock === 0 ? 'Sold out' : available === 0 ? 'All available items are in your cart' : 'Add to cart'}
            </button>
            {/* Buy now = add and go to the cart. */}
            <button className="large" disabled={available === 0} onClick={() => addToCart(true)}>Buy now</button>
          </div>
          {/* Hint how many are already in the cart. */}
          {inCart > 0 && <p className="muted small">{inCart} already in your <Link to="/cart">cart</Link>.</p>}

          {/* Shop benefits. */}
          <ul className="detail-perks">
            {/* Shipping. */}
            <li><TruckIcon /> Free shipping, delivered in 1–3 business days</li>
            {/* Returns. */}
            <li><ReturnIcon /> 30-day returns</li>
            {/* Data source: products that come from the SAP ERP. */}
            {product.erpManaged && (
              // Via file transfer (Lab 2) or live through the API.
              <li><DatabaseIcon /> {product.erpSource === 'file' ? 'Price and stock from the SAP ERP (file transfer)' : 'Price and stock are live from the SAP ERP'}</li>
            )}
          </ul>
        </div>
      </div>

      {/* Related products, if any. */}
      {related.length > 0 && (
        // Related section.
        <section className="related">
          {/* Title. */}
          <h2>More in {product.category}</h2>
          {/* Grid of small cards. */}
          <div className="related-grid">
            {/* One card per product. */}
            {related.map(r => (
              // Link to the related product.
              <Link key={r.id} to={`/products/${r.id}`} className="related-card">
                {/* Small picture. */}
                <ProductArt product={r} size="small" />
                {/* Name and price. */}
                <span><strong>{r.name}</strong><span className="muted small">{money(r.price, r.currency)}</span></span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
