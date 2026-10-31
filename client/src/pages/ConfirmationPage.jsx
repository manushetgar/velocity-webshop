// ConfirmationPage.jsx - shown after a successful checkout (/order-confirmation/:id): order number, ERP order
// number, items, total and delivery address.
//
// React hooks: effect for loading, state.
import { useEffect, useState } from 'react';
// Router: links and the :id parameter of the URL.
import { Link, useParams } from 'react-router-dom';
// API call and formatting.
import { api, dateTime, money } from '../api.js';
// Check mark icon.
import { CheckIcon } from '../components/Icons.jsx';

// The confirmation page.
export default function ConfirmationPage() {
  // Order id from the URL.
  const { id } = useParams();
  // The loaded order (null while loading).
  const [order, setOrder] = useState(null);
  // Error message, e.g. when the order belongs to somebody else (404).
  const [error, setError] = useState('');

  // Load the order (GET /api/orders/:id) when the page opens.
  useEffect(() => { api.order(id).then(setOrder).catch(e => setError(e.message)); }, [id]);

  // Error: show it instead of the page.
  if (error) return <div className="container"><div className="empty">{error}</div></div>;
  // Still loading.
  if (!order) return <div className="container"><p className="muted">Loading…</p></div>;

  // The confirmation.
  return (
    // Narrow, centered page.
    <div className="container narrow-center">
      {/* The three checkout steps; all done. */}
      <ol className="checkout-steps">
        {/* Step 1 done. */}
        <li className="done">Cart</li>
        {/* Step 2 done. */}
        <li className="done">Shipping & review</li>
        {/* Current step. */}
        <li className="current">Confirmation</li>
      </ol>
      {/* Confirmation card. */}
      <div className="card confirmation">
        {/* Big check mark. */}
        <div className="confirm-icon"><CheckIcon width="34" height="34" /></div>
        {/* Headline. */}
        <h1>Thank you for your order!</h1>
        {/* Shop order number and date. */}
        <p className="muted">Order #{order.id} was placed on {dateTime(order.orderDate)}.</p>
        {/* The order number in the SAP ERP, if it was created there. */}
        {order.erpOrderNumber && (
          // Note that the order exists in the ERP and the stock was reserved there.
          <p className="erp-note">It has been created in the SAP ERP as <strong>order #{order.erpOrderNumber}</strong>; the stock was reserved there.</p>
        )}
        {/* Ordered items. */}
        <ul className="order-items">
          {/* One line per item. */}
          {order.items.map((i, idx) => (
            // One item line.
            <li key={idx}>
              {/* Product name. */}
              <span>{i.productName}</span>
              {/* Quantity x unit price. */}
              <span className="muted">{i.quantity} × {money(i.unitPrice, order.currency)}</span>
              {/* Line total. */}
              <span className="right">{money(i.itemTotal, order.currency)}</span>
            </li>
          ))}
          {/* Total line. */}
          <li className="total-line"><span>Total</span><span /><span className="right">{money(order.total, order.currency)}</span></li>
        </ul>
        {/* Delivery address. */}
        <p className="muted small">
          {/* Name, street, house number, postal code and city. */}
          Shipping to {order.shippingAddress.name}, {order.shippingAddress.street} {order.shippingAddress.houseNumber}, {order.shippingAddress.postalCode} {order.shippingAddress.city}
        </p>
        {/* Next steps. */}
        <div className="row center-row">
          {/* To My account > Orders. */}
          <Link to="/account/orders" className="button primary">View my orders</Link>
          {/* Back to the shop. */}
          <Link to="/" className="button">Continue shopping</Link>
        </div>
      </div>
    </div>
  );
}
