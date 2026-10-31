// CheckoutPage.jsx - checkout (/checkout, login required): shipping address, review of the items and the total.
// "Place order" sends the cart to POST /api/orders; the server creates the order in the SAP ERP first (ERP first)
// and the page then opens the confirmation.
//
// React hooks: effect (ERP status), state (form and flags).
import { useEffect, useState } from 'react';
// Router: links, redirects and navigation.
import { Link, Navigate, useNavigate } from 'react-router-dom';
// API calls and money formatting.
import { api, money } from '../api.js';
// Logged-in user and cart.
import { useAuth, useCart } from '../state.jsx';
// Notifications.
import { useToast } from '../components/Toast.jsx';
// Address inputs.
import AddressFields from '../components/AddressFields.jsx';
// Product pictures.
import ProductArt from '../components/ProductArt.jsx';

// The checkout page.
export default function CheckoutPage() {
  // The user (with the stored address) and the setter for the updated profile.
  const { user, setUser } = useAuth();
  // Cart items, total, number of items and the clear action.
  const { items, total, count, clear } = useCart();
  // Notifications.
  const toast = useToast();
  // Navigation to the confirmation.
  const navigate = useNavigate();
  // Address in the form (starts with the stored address).
  const [address, setAddress] = useState(user.address);
  // Address form open when the stored address is incomplete.
  const [editing, setEditing] = useState(!(user.address.street && user.address.city && user.address.postalCode));
  // Error message of the last order attempt (e.g. not enough stock in the ERP).
  const [error, setError] = useState('');
  // true while the order is sent.
  const [busy, setBusy] = useState(false);
  // Id of the placed order (prevents the redirect to the empty cart).
  const [placedId, setPlacedId] = useState(null);
  // State of the ERP connection (where the order goes).
  const [erp, setErp] = useState(null);
  // where the order goes: the SAP ERP (API integration) or only the shop (standalone / file transfer, Lab 2)
  useEffect(() => { api.erpStatus().then(setErp).catch(() => {}); }, []);

  // after a successful order the cart is empty; do not bounce back to the cart in that moment
  // Empty cart (and no order just placed): nothing to check out, back to the cart.
  if (items.length === 0 && !placedId) return <Navigate to="/cart" replace />;
  // Order placed: short text until the confirmation page opens.
  if (placedId) return <p className="container muted">Opening your order confirmation…</p>;

  // Saves the edited address in the profile (PUT /api/me; also updates the ERP customer).
  const saveAddress = async () => {
    try {
      // Send the new address.
      const updated = await api.updateMe({ address });
      // Updated user in the global state.
      setUser(updated);
      // Close the address form.
      setEditing(false);
      // Confirmation.
      toast('Shipping address saved', 'success');
    } catch (e) {
      // Error message.
      toast(e.message, 'error');
    }
  };

  // Places the order.
  const placeOrder = async () => {
    // Clear the old error.
    setError('');
    // Disable the button.
    setBusy(true);
    try {
      // POST /api/orders with product ids and quantities only - prices are read on the server.
      const order = await api.checkout(items.map(i => ({ productId: i.product.id, quantity: i.quantity })));
      // Remember the new order.
      setPlacedId(order.id);
      // Empty the cart.
      clear();
      // Open the confirmation; replace = the checkout is not kept in the history.
      navigate(`/order-confirmation/${order.id}`, { replace: true });
    } catch (e) {
      // Error from the server or the ERP (e.g. 409 exceeds stock, 503 ERP not reachable).
      setError(e.message);
    } finally {
      // Enable the button again.
      setBusy(false);
    }
  };

  // The stored address (shown when the form is closed).
  const a = user.address;
  // The page markup.
  return (
    // Centered page width.
    <div className="container">
      {/* Progress of the checkout. */}
      <ol className="checkout-steps">
        {/* Step 1 done: back to the cart. */}
        <li className="done"><Link to="/cart">Cart</Link></li>
        {/* Current step. */}
        <li className="current">Shipping & review</li>
        {/* Next step. */}
        <li>Confirmation</li>
      </ol>
      {/* Page title. */}
      <h1 className="page-title">Checkout</h1>

      {/* Two columns: address and items on the left, total on the right. */}
      <div className="two-col">
        {/* Left column. */}
        <div className="stack">
          {/* Shipping address card. */}
          <section className="card">
            {/* Head with the change link. */}
            <div className="section-head">
              {/* Title. */}
              <h3>1. Shipping address</h3>
              {/* Open the address form. */}
              {!editing && <button className="link" onClick={() => setEditing(true)}>Change</button>}
            </div>
            {/* Form or the stored address. */}
            {editing ? (
              // Address form.
              <div className="form-grid three">
                {/* Address inputs. */}
                <AddressFields value={address} onChange={setAddress} />
                {/* Buttons. */}
                <div className="span-all row">
                  {/* Save the address in the profile. */}
                  <button className="primary" onClick={saveAddress}>Save address</button>
                  {/* Cancel (only if an address exists): back to the stored address. */}
                  {a.street && <button className="link" onClick={() => { setAddress(a); setEditing(false); }}>Cancel</button>}
                </div>
              </div>
            ) : (
              // Stored address.
              <address className="address">
                {/* Name. */}
                <strong>{user.name}</strong><br />
                {/* Street and house number. */}
                {a.street} {a.houseNumber}<br />
                {/* Postal code, city and country. */}
                {a.postalCode} {a.city}, {a.countryCode}<br />
                {/* E-mail. */}
                <span className="muted">{user.email}</span>
              </address>
            )}
          </section>

          {/* Items card. */}
          <section className="card">
            {/* Title. */}
            <h3>2. Review items</h3>
            {/* Item lines. */}
            <div className="review-lines">
              {/* One line per cart item. */}
              {items.map(({ product, quantity }) => (
                // One item line.
                <div key={product.id} className="review-line">
                  {/* Small picture. */}
                  <ProductArt product={product} size="thumb" />
                  {/* Name, quantity and unit price. */}
                  <span><strong>{product.name}</strong><span className="muted small">{quantity} × {money(product.price, product.currency)}</span></span>
                  {/* Line total. */}
                  <span className="right">{money(product.price * quantity, product.currency)}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Order total. */}
        <aside className="card summary">
          {/* Title. */}
          <h3>Order total</h3>
          {/* Items. */}
          <div className="summary-row"><span>Items ({count})</span><span>{money(total)}</span></div>
          {/* Shipping (free). */}
          <div className="summary-row"><span>Shipping</span><span className="free">Free</span></div>
          {/* Total. */}
          <div className="summary-row total"><span>Total</span><span>{money(total)}</span></div>
          {/* Payment note and where the order goes: the shop (standalone / file transfer) or the SAP ERP. */}
          <p className="muted small">Payment on delivery (demo). {erp && !erp.ordersToErp
            ? 'Your order is stored in the shop, which also checks the stock.'
            : 'Your order is created in the SAP ERP, which also checks the stock.'}</p>
          {/* Error message of the last attempt. */}
          {error && <p className="error small">{error}</p>}
          {/* Place order (disabled while sending or while the address form is open). */}
          <button className="primary block large" disabled={busy || editing} onClick={placeOrder}>
            {/* Button text with the total. */}
            {busy ? 'Placing order…' : `Place order · ${money(total)}`}
          </button>
          {/* Hint while the address form is open. */}
          {editing && <p className="muted small center">Save your shipping address first.</p>}
        </aside>
      </div>
    </div>
  );
}
