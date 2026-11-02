import { useState } from 'react';
import { api, dateTime, money } from '../api.js';
import { useToast } from './Toast.jsx';
import StatusSteps from './StatusSteps.jsx';

export const STATUSES = ['NEW', 'PICKED', 'SHIPPED', 'COMPLETED', 'CANCELED'];

export function StatusBadge({ status }) {
  return <span className={`status s-${status.toLowerCase()}`}>{status}</span>;
}

export default function OrderCard({ order, isAdmin, showCustomer, onChange }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const run = async (fn, successText) => {
    setBusy(true);
    try {
      onChange(await fn());
      toast(successText, 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const a = order.shippingAddress;
  return (
    <article className="card order">
      <div className="order-head">
        <div>
          <div className="order-title">
            <strong>Order #{order.id}</strong>
            {order.erpOrderNumber && (
              <span className="tag erp" title={`Created in ${order.erpConnector?.name || 'the Mini-ERP'}`}>SAP ERP #{order.erpOrderNumber}</span>
            )}
            {isAdmin && order.erpConnector && <span className="tag">{order.erpConnector.name}</span>}
            <StatusBadge status={order.status} />
          </div>
          <div className="muted small">
            {dateTime(order.orderDate)}
            {showCustomer && <> · {order.customer.name} ({order.customer.email})</>}
          </div>
        </div>
        <div className="order-total">{money(order.total, order.currency)}</div>
      </div>

      <StatusSteps status={order.status} />

      <ul className="order-items">
        {order.items.map((i, idx) => (
          <li key={idx}>
            <span>{i.productName}</span>
            <span className="muted">{i.quantity} × {money(i.unitPrice, order.currency)}</span>
            <span className="right">{money(i.itemTotal, order.currency)}</span>
          </li>
        ))}
      </ul>

      <div className="order-foot">
        <span className="muted small">
          Ship to {a.name}, {a.street} {a.houseNumber}, {a.postalCode} {a.city}, {a.countryCode}
        </span>
        <div className="row">
          {isAdmin && order.status !== 'CANCELED' && (
            <label className="row small status-select">
              Set status
              <select value={order.status} disabled={busy} aria-label="Order status"
                      onChange={e => run(() => api.setOrderStatus(order.id, e.target.value), `Order #${order.id} set to ${e.target.value}`)}>
                {STATUSES.map(s => <option key={s}>{s}</option>)}
              </select>
            </label>
          )}
          {!isAdmin && order.status === 'NEW' && (
            <button className="link danger" disabled={busy}
                    onClick={() => confirm('Cancel this order?') && run(() => api.cancelOrder(order.id), `Order #${order.id} canceled`)}>
              Cancel order
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
