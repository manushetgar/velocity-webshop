import { db } from '../db.js';
import { clientFor, ErpError } from './erpClient.js';
import { getActiveConnector } from './connectors.js';
import { syncProductsFromErp } from './productSync.js';

export const erpOrdersEnabled = () => {
  const conn = getActiveConnector();
  return !!conn && conn.integration !== 'file';
};

// The Mini-ERP's cancelOrder currently always answers 422 (ERP-side bug); the shop then leaves the order unchanged.
const ACTIONS = { PICKED: 'pickOrder', SHIPPED: 'shipOrder', COMPLETED: 'completeOrder', CANCELED: 'cancelOrder' };

export async function ensureErpCustomer(customer, conn = getActiveConnector()) {
  if (!conn) throw new ErpError('No SAP connector is active.', 503);
  const api = clientFor(conn);
  // Match by e-mail because the ERP's in-memory data may have been recreated after a restart.
  // Reusing an obsolete local erp_customer_id could point to a missing customer.
  let c = await api.findCustomerByEmail(customer.email);
  if (!c) {
    c = await api.createCustomer({
      name: customer.name, email: customer.email, street: customer.street, houseNumber: customer.house_number,
      city: customer.city, postalCode: customer.postal_code, country_code: customer.country_code || 'DE',
    });
  }
  db.prepare('UPDATE customers SET erp_customer_id = ?, erp_connector = ? WHERE id = ?').run(c.ID, conn.id, customer.id);
  return c.ID;
}

async function ensureErpProductIds(lines, conn) {
  // This is the checkout-time stock read, separate from the product-page read.
  // It narrows the stale-data window and also obtains the ERP identifiers required by the order payload.
  const erpProducts = await clientFor(conn).products();
  if (!Array.isArray(erpProducts))
    throw new ErpError(`Unexpected product response from ${conn.name}.`, 502);

  const liveById = new Map(erpProducts.map(p => [String(p.productID || '').toUpperCase(), p]));
  // Refresh the local product copy so IDs, names, and prices match the same ERP response.
  await syncProductsFromErp(conn, erpProducts);
  const reload = db.prepare('SELECT * FROM products WHERE id = ?');
  return lines.map(l => {
    const product = reload.get(l.product.id);
    if (!product.erp_id || product.erp_connector !== conn.id)
      throw new ErpError(`${product.name} (${product.product_id}) does not exist in ${conn.name}.`, 409);

    const live = liveById.get(product.product_id.toUpperCase());
    const stock = Number(live?.stock);
    if (!live || !Number.isInteger(stock) || stock < 0)
      throw new ErpError(`Stock information for "${product.name}" is invalid in ${conn.name}.`, 502);
    if (stock < l.quantity)
      throw new ErpError(`Not enough stock for "${product.name}" (available: ${stock}).`, 409);
    // Two customers can both pass this check while one unit remains. Nothing is locked or reserved here;
    // the final decision must happen inside the ERP's order write/stock-decrement handling.
    return { ...l, product };
  });
}

export async function createErpOrder(customer, lines, currency) {
  const conn = getActiveConnector();
  if (!conn) throw new ErpError('No SAP connector is active.', 503);
  // Resolve product IDs and perform the fresh stock pre-check before contacting the order endpoint.
  const resolved = await ensureErpProductIds(lines, conn);
  const totalCents = resolved.reduce((sum, l) => sum + l.product.price_cents * l.quantity, 0);
  const customerId = await ensureErpCustomer(customer, conn);
  // This OData POST is the synchronous decision point: checkout waits for the ERP to accept or reject it.
  // Order POST retries are disabled in erpClient because a lost response may hide an already committed order.
  const order = await clientFor(conn).createOrder({
    customer_ID: customerId,
    orderDate: new Date().toISOString().slice(0, 10),
    orderAmount: totalCents / 100,
    currency_code: currency,
    items: resolved.map(({ product, quantity }) => ({
      product_ID: product.erp_id,
      quantity,
      itemAmount: (product.price_cents * quantity) / 100,
      currency_code: product.currency,
    })),
  });
  return { id: order.ID, number: order.orderID, connector: conn.id, lines: resolved, totalCents };
}

export async function setErpOrderStatus(order, status) {
  const action = ACTIONS[status];
  if (!action) throw new ErpError(`Status ${status} cannot be set in the ERP.`, 422);
  const conn = order.erp_connector && db.prepare('SELECT * FROM erp_connectors WHERE id = ?').get(order.erp_connector);
  if (!conn) throw new ErpError('The SAP connector of this order no longer exists.', 409);
  await clientFor(conn).orderAction(order.erp_order_id, action);
}
