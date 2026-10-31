// OrderCard.jsx - one order as a card: number, ERP number, status, progress, items, delivery address and actions.
// Used in My account (customer: cancel) and in Admin > Orders (admin: change the status).
//
// State for the busy flag.
import { useState } from 'react';
// API calls and formatting of dates and money.
import { api, dateTime, money } from '../api.js';
// Notifications.
import { useToast } from './Toast.jsx';
// Progress bar of the order.
import StatusSteps from './StatusSteps.jsx';

// All order statuses (same codes as the Mini-ERP's OrderStatus); used for the admin's select box.
export const STATUSES = ['NEW', 'PICKED', 'SHIPPED', 'COMPLETED', 'CANCELED'];

// Colored status label, e.g. SHIPPED (color from the CSS class s-shipped).
export function StatusBadge({ status }) {
  // The label.
  return <span className={`status s-${status.toLowerCase()}`}>{status}</span>;
}

// One order with items, progress and actions. Used in "My account" and in the admin area.
export default function OrderCard({ order, isAdmin, showCustomer, onChange }) {
  // Notifications.
  const toast = useToast();
  // true while a change is sent (disables the controls).
  const [busy, setBusy] = useState(false);

  // Runs an action (API call), passes the updated order to the parent and shows a success or error message.
  const run = async (fn, successText) => {
    // Disable the controls.
    setBusy(true);
    try {
      // Wait for the API and hand the updated order to the parent list.
      onChange(await fn());
      // Success message.
      toast(successText, 'success');
    } catch (e) {
      // Error message from the server (e.g. the ERP refused the status change).
      toast(e.message, 'error');
    } finally {
      // Enable the controls again in both cases.
      setBusy(false);
    }
  };

  // Delivery address copied into the order at checkout.
  const a = order.shippingAddress;
  // The card markup.
  return (
    // Card frame.
    <article className="card order">
      {/* Head: title, tags, date, total. */}
      <div className="order-head">
        {/* Left part. */}
        <div>
          {/* Title line. */}
          <div className="order-title">
            {/* Shop order number. */}
            <strong>Order #{order.id}</strong>
            {/* The ERP order number, if the order was created in the ERP. */}
            {order.erpOrderNumber && (
              // Tag with the ERP number; the tooltip names the ERP (connector).
              <span className="tag erp" title={`Created in ${order.erpConnector?.name || 'the Mini-ERP'}`}>SAP ERP #{order.erpOrderNumber}</span>
            )}
            {/* Admins also see which ERP (connector) the order belongs to. */}
            {isAdmin && order.erpConnector && <span className="tag">{order.erpConnector.name}</span>}
            {/* Current status. */}
            <StatusBadge status={order.status} />
          </div>
          {/* Date and (for admins) the customer. */}
          <div className="muted small">
            {/* Order date and time. */}
            {dateTime(order.orderDate)}
            {/* Customer name and e-mail (admin lists only). */}
            {showCustomer && <> · {order.customer.name} ({order.customer.email})</>}
          </div>
        </div>
        {/* Total amount. */}
        <div className="order-total">{money(order.total, order.currency)}</div>
      </div>

      {/* Progress bar. */}
      <StatusSteps status={order.status} />

      {/* Order items. */}
      <ul className="order-items">
        {/* One line per item. */}
        {order.items.map((i, idx) => (
          // One item line.
          <li key={idx}>
            {/* Product name (copied at order time). */}
            <span>{i.productName}</span>
            {/* Quantity x unit price. */}
            <span className="muted">{i.quantity} × {money(i.unitPrice, order.currency)}</span>
            {/* Line total. */}
            <span className="right">{money(i.itemTotal, order.currency)}</span>
          </li>
        ))}
      </ul>

      {/* Footer: address and actions. */}
      <div className="order-foot">
        {/* Delivery address. */}
        <span className="muted small">
          {/* Name, street, house number, postal code, city, country. */}
          Ship to {a.name}, {a.street} {a.houseNumber}, {a.postalCode} {a.city}, {a.countryCode}
        </span>
        {/* Actions. */}
        <div className="row">
          {/* Admin: status select box (not for canceled orders). */}
          {isAdmin && order.status !== 'CANCELED' && (
            // Label with the select box.
            <label className="row small status-select">
              {/* Label text. */}
              Set status
              {/* Choosing a status sends it to the server, which runs the matching ERP action (pickOrder, shipOrder ...). */}
              <select value={order.status} disabled={busy} aria-label="Order status"
                      onChange={e => run(() => api.setOrderStatus(order.id, e.target.value), `Order #${order.id} set to ${e.target.value}`)}>
                {/* One option per status. */}
                {STATUSES.map(s => <option key={s}>{s}</option>)}
              </select>
            </label>
          )}
          {/* Customer: cancel button while the order is NEW. */}
          {!isAdmin && order.status === 'NEW' && (
            // Asks for confirmation, then cancels the order.
            <button className="link danger" disabled={busy}
                    onClick={() => confirm('Cancel this order?') && run(() => api.cancelOrder(order.id), `Order #${order.id} canceled`)}>
              {/* Button text. */}
              Cancel order
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
