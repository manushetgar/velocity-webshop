import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, dateTime, money } from '../api.js';
import { CheckIcon } from '../components/Icons.jsx';

export default function ConfirmationPage() {
  const { id } = useParams();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { api.order(id).then(setOrder).catch(e => setError(e.message)); }, [id]);

  if (error) return <div className="container"><div className="empty">{error}</div></div>;
  if (!order) return <div className="container"><p className="muted">Loading…</p></div>;

  return (
    <div className="container narrow-center">
      <ol className="checkout-steps">
        <li className="done">Cart</li>
        <li className="done">Shipping & review</li>
        <li className="current">Confirmation</li>
      </ol>
      <div className="card confirmation">
        <div className="confirm-icon"><CheckIcon width="34" height="34" /></div>
        <h1>Thank you for your order!</h1>
        <p className="muted">Order #{order.id} was placed on {dateTime(order.orderDate)}.</p>
        {order.erpOrderNumber && (
          <p className="erp-note">It has been created in the SAP ERP as <strong>order #{order.erpOrderNumber}</strong>; the stock was reserved there.</p>
        )}
        <ul className="order-items">
          {order.items.map((i, idx) => (
            <li key={idx}>
              <span>{i.productName}</span>
              <span className="muted">{i.quantity} × {money(i.unitPrice, order.currency)}</span>
              <span className="right">{money(i.itemTotal, order.currency)}</span>
            </li>
          ))}
          <li className="total-line"><span>Total</span><span /><span className="right">{money(order.total, order.currency)}</span></li>
        </ul>
        <p className="muted small">
          Shipping to {order.shippingAddress.name}, {order.shippingAddress.street} {order.shippingAddress.houseNumber}, {order.shippingAddress.postalCode} {order.shippingAddress.city}
        </p>
        <div className="row center-row">
          <Link to="/account/orders" className="button primary">View my orders</Link>
          <Link to="/" className="button">Continue shopping</Link>
        </div>
      </div>
    </div>
  );
}
