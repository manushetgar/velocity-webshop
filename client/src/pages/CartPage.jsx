// CartPage.jsx - the shopping cart (/cart): items with quantity, remove, empty, and the order summary with the way
// to the checkout. The cart lives in the browser (state.jsx) until the order is placed.
//
// Router: links and navigation.
import { Link, useNavigate } from 'react-router-dom';
// Money formatting.
import { money } from '../api.js';
// Login state and cart.
import { useAuth, useCart } from '../state.jsx';
// Quantity input.
import QuantityStepper from '../components/QuantityStepper.jsx';
// Product picture.
import ProductArt from '../components/ProductArt.jsx';

// The cart page.
export default function CartPage() {
  // Cart items and actions, total and number of items.
  const { items, setQuantity, remove, clear, total, count } = useCart();
  // Logged-in user (checkout needs a login).
  const { user } = useAuth();
  // Navigation to the checkout or login.
  const navigate = useNavigate();

  // Empty cart: a short message instead of the table.
  if (items.length === 0)
    // The empty state.
    return (
      // Centered page width.
      <div className="container">
        {/* Page title. */}
        <h1 className="page-title">Your cart</h1>
        {/* Empty message box. */}
        <div className="empty">
          {/* Message. */}
          <p>Your cart is empty.</p>
          {/* Back to the products. */}
          <Link to="/" className="button primary">Browse products</Link>
        </div>
      </div>
    );

  // Cart with items.
  return (
    // Centered page width.
    <div className="container">
      {/* Title with the number of items. */}
      <h1 className="page-title">Your cart <span className="muted">({count})</span></h1>
      {/* Two columns: items on the left, summary on the right. */}
      <div className="two-col">
        {/* Card with the item lines. */}
        <div className="card cart-lines">
          {/* One line per product. */}
          {items.map(({ product, quantity }) => (
            // One cart line.
            <div className="cart-line" key={product.id}>
              {/* Small picture, links to the product. */}
              <Link to={`/products/${product.id}`}><ProductArt product={product} size="thumb" /></Link>
              {/* Name, product ID, unit price and remove link. */}
              <div className="cart-line-info">
                {/* Product name, links to the product. */}
                <Link to={`/products/${product.id}`} className="plain"><strong>{product.name}</strong></Link>
                {/* Product ID and unit price. */}
                <span className="muted small">{product.productId} · {money(product.price, product.currency)} each</span>
                {/* Remove this product from the cart. */}
                <button className="link danger small-link" onClick={() => remove(product.id)}>Remove</button>
              </div>
              {/* Quantity, at most the stock of the product. */}
              <QuantityStepper value={quantity} onChange={q => setQuantity(product.id, q)} max={Math.max(1, product.stock)} />
              {/* Line total. */}
              <span className="cart-line-total">{money(product.price * quantity, product.currency)}</span>
            </div>
          ))}
          {/* Actions below the lines. */}
          <div className="cart-actions">
            {/* Back to the shop. */}
            <Link to="/">Continue shopping</Link>
            {/* Remove all items. */}
            <button className="link" onClick={clear}>Empty cart</button>
          </div>
        </div>

        {/* Order summary. */}
        <aside className="card summary">
          {/* Title. */}
          <h3>Order summary</h3>
          {/* Subtotal. */}
          <div className="summary-row"><span>Subtotal ({count} items)</span><span>{money(total)}</span></div>
          {/* Shipping (always free in this shop). */}
          <div className="summary-row"><span>Shipping</span><span className="free">Free</span></div>
          {/* Total. */}
          <div className="summary-row total"><span>Total</span><span>{money(total)}</span></div>
          {/* VAT included in the total (19 %). */}
          <p className="muted small">Incl. 19% VAT ({money(total - total / 1.19)})</p>
          {/* To the checkout; without a login first to the login page, which returns to the checkout afterwards. */}
          <button className="primary block large" onClick={() => navigate(user ? '/checkout' : '/login', { state: { from: '/checkout' } })}>
            {/* Button text depends on the login. */}
            {user ? 'Proceed to checkout' : 'Log in to check out'}
          </button>
          {/* Not logged in: link to the registration (also returns to the checkout). */}
          {!user && <p className="muted small center">New here? <Link to="/register" state={{ from: '/checkout' }}>Create an account</Link></p>}
        </aside>
      </div>
    </div>
  );
}
