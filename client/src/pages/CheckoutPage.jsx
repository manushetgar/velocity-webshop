import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api, money } from '../api.js';
import { useAuth, useCart } from '../state.jsx';
import { useToast } from '../components/Toast.jsx';
import AddressFields from '../components/AddressFields.jsx';
import ProductArt from '../components/ProductArt.jsx';

export default function CheckoutPage() {
  const { user, setUser } = useAuth();
  const { items, total, count, clear } = useCart();
  const toast = useToast();
  const navigate = useNavigate();
  const [address, setAddress] = useState(user.address);
  const [editing, setEditing] = useState(!(user.address.street && user.address.city && user.address.postalCode));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [placedId, setPlacedId] = useState(null);
  const [erp, setErp] = useState(null);
  useEffect(() => { api.erpStatus().then(setErp).catch(() => {}); }, []);

  if (items.length === 0 && !placedId) return <Navigate to="/cart" replace />;
  if (placedId) return <p className="container muted">Opening your order confirmation…</p>;

  const saveAddress = async () => {
    try {
      const updated = await api.updateMe({ address });
      setUser(updated);
      setEditing(false);
      toast('Shipping address saved', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const placeOrder = async () => {
    setError('');
    setBusy(true);
    try {
      const order = await api.checkout(items.map(i => ({ productId: i.product.id, quantity: i.quantity })));
      setPlacedId(order.id);
      clear();
      navigate(`/order-confirmation/${order.id}`, { replace: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const a = user.address;
  return (
    <div className="container">
      <ol className="checkout-steps">
        <li className="done"><Link to="/cart">Cart</Link></li>
        <li className="current">Shipping & review</li>
        <li>Confirmation</li>
      </ol>
      <h1 className="page-title">Checkout</h1>

      <div className="two-col">
        <div className="stack">
          <section className="card">
            <div className="section-head">
              <h3>1. Shipping address</h3>
              {!editing && <button className="link" onClick={() => setEditing(true)}>Change</button>}
            </div>
            {editing ? (
              <div className="form-grid three">
                <AddressFields value={address} onChange={setAddress} />
                <div className="span-all row">
                  <button className="primary" onClick={saveAddress}>Save address</button>
                  {a.street && <button className="link" onClick={() => { setAddress(a); setEditing(false); }}>Cancel</button>}
                </div>
              </div>
            ) : (
              <address className="address">
                <strong>{user.name}</strong><br />
                {a.street} {a.houseNumber}<br />
                {a.postalCode} {a.city}, {a.countryCode}<br />
                <span className="muted">{user.email}</span>
              </address>
            )}
          </section>

          <section className="card">
            <h3>2. Review items</h3>
            <div className="review-lines">
              {items.map(({ product, quantity }) => (
                <div key={product.id} className="review-line">
                  <ProductArt product={product} size="thumb" />
                  <span><strong>{product.name}</strong><span className="muted small">{quantity} × {money(product.price, product.currency)}</span></span>
                  <span className="right">{money(product.price * quantity, product.currency)}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        <aside className="card summary">
          <h3>Order total</h3>
          <div className="summary-row"><span>Items ({count})</span><span>{money(total)}</span></div>
          <div className="summary-row"><span>Shipping</span><span className="free">Free</span></div>
          <div className="summary-row total"><span>Total</span><span>{money(total)}</span></div>
          <p className="muted small">Payment on delivery (demo). {erp && !erp.ordersToErp
            ? 'Your order is stored in the shop, which also checks the stock.'
            : 'Your order is created in the SAP ERP, which also checks the stock.'}</p>
          {error && <p className="error small">{error}</p>}
          <button className="primary block large" disabled={busy || editing} onClick={placeOrder}>
            {busy ? 'Placing order…' : `Place order · ${money(total)}`}
          </button>
          {editing && <p className="muted small center">Save your shipping address first.</p>}
        </aside>
      </div>
    </div>
  );
}
