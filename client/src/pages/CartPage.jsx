import { Link, useNavigate } from 'react-router-dom';
import { money } from '../api.js';
import { useAuth, useCart } from '../state.jsx';
import QuantityStepper from '../components/QuantityStepper.jsx';
import ProductArt from '../components/ProductArt.jsx';

export default function CartPage() {
  const { items, setQuantity, remove, clear, total, count } = useCart();
  const { user } = useAuth();
  const navigate = useNavigate();

  if (items.length === 0)
    return (
      <div className="container">
        <h1 className="page-title">Your cart</h1>
        <div className="empty">
          <p>Your cart is empty.</p>
          <Link to="/" className="button primary">Browse products</Link>
        </div>
      </div>
    );

  return (
    <div className="container">
      <h1 className="page-title">Your cart <span className="muted">({count})</span></h1>
      <div className="two-col">
        <div className="card cart-lines">
          {items.map(({ product, quantity }) => (
            <div className="cart-line" key={product.id}>
              <Link to={`/products/${product.id}`}><ProductArt product={product} size="thumb" /></Link>
              <div className="cart-line-info">
                <Link to={`/products/${product.id}`} className="plain"><strong>{product.name}</strong></Link>
                <span className="muted small">{product.productId} · {money(product.price, product.currency)} each</span>
                <button className="link danger small-link" onClick={() => remove(product.id)}>Remove</button>
              </div>
              <QuantityStepper value={quantity} onChange={q => setQuantity(product.id, q)} max={Math.max(1, product.stock)} />
              <span className="cart-line-total">{money(product.price * quantity, product.currency)}</span>
            </div>
          ))}
          <div className="cart-actions">
            <Link to="/">Continue shopping</Link>
            <button className="link" onClick={clear}>Empty cart</button>
          </div>
        </div>

        <aside className="card summary">
          <h3>Order summary</h3>
          <div className="summary-row"><span>Subtotal ({count} items)</span><span>{money(total)}</span></div>
          <div className="summary-row"><span>Shipping</span><span className="free">Free</span></div>
          <div className="summary-row total"><span>Total</span><span>{money(total)}</span></div>
          <p className="muted small">Incl. 19% VAT ({money(total - total / 1.19)})</p>
          <button className="primary block large" onClick={() => navigate(user ? '/checkout' : '/login', { state: { from: '/checkout' } })}>
            {user ? 'Proceed to checkout' : 'Log in to check out'}
          </button>
          {!user && <p className="muted small center">New here? <Link to="/register" state={{ from: '/checkout' }}>Create an account</Link></p>}
        </aside>
      </div>
    </div>
  );
}
