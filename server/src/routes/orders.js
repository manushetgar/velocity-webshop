import { Router } from 'express';
import { db, ORDER_STATUSES } from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';
import { reserve, release, mirrorErpReservation } from '../services/inventory.js';
import { erpOrdersEnabled, createErpOrder, setErpOrderStatus } from '../services/erpOrders.js';
import { syncProductsFromErp } from '../services/productSync.js';
import { getActiveConnector } from '../services/connectors.js';
import { httpError } from '../util.js';

const router = Router();

function orderToApi(o) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(o.id);
  return {
    id: o.id,
    orderDate: o.order_date,
    status: o.status,
    total: o.total_cents / 100,
    currency: o.currency,
    erpOrderId: o.erp_order_id,
    erpOrderNumber: o.erp_order_number,
    erpConnector: o.erp_connector_name ? { id: o.erp_connector, name: o.erp_connector_name } : null,
    customer: { id: o.customer_id, name: o.customer_name, email: o.customer_email },
    shippingAddress: {
      name: o.ship_name, street: o.ship_street, houseNumber: o.ship_house_number,
      postalCode: o.ship_postal_code, city: o.ship_city, countryCode: o.ship_country_code,
    },
    items: items.map(i => ({
      productId: i.product_id,
      productName: i.product_name,
      unitPrice: i.unit_price_cents / 100,
      quantity: i.quantity,
      itemTotal: i.item_total_cents / 100,
    })),
  };
}

const ORDER_SELECT = `SELECT o.*, c.name AS customer_name, c.email AS customer_email, ec.name AS erp_connector_name
                      FROM orders o JOIN customers c ON c.id = o.customer_id
                      LEFT JOIN erp_connectors ec ON ec.id = o.erp_connector`;

function loadOrder(id, user) {
  const o = db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(id);
  if (!o || (user.role !== 'admin' && o.customer_id !== user.id)) throw httpError(404, 'Order not found.');
  return o;
}

const refreshStockFromErp = () => {
  const conn = getActiveConnector();
  if (conn) syncProductsFromErp(conn).catch(() => {});
};

router.post('/', requireAuth, async (req, res) => {
  const lines = Array.isArray(req.body.items) ? req.body.items : [];
  if (lines.length === 0) throw httpError(400, 'Your cart is empty.');

  const merged = new Map();
  for (const l of lines) {
    const qty = Number(l.quantity);
    if (!Number.isInteger(qty) || qty < 1) throw httpError(400, 'Quantities must be whole numbers >= 1.');
    merged.set(Number(l.productId), (merged.get(Number(l.productId)) || 0) + qty);
  }
  let resolved = [...merged].map(([id, quantity]) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(id);
    if (!product) throw httpError(400, `Product ${id} is not available.`);
    return { product, quantity };
  });

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.user.id);
  if (!customer.street || !customer.city || !customer.postal_code)
    throw httpError(400, 'Please add your address in your profile before checking out.');

  const currency = resolved[0].product.currency;
  let total = resolved.reduce((sum, l) => sum + l.product.price_cents * l.quantity, 0);

  // ERP first: if the ERP rejects the order, nothing is written locally.
  const erpOrder = erpOrdersEnabled() ? await createErpOrder(customer, resolved, currency) : null;
  if (erpOrder) ({ lines: resolved, totalCents: total } = erpOrder);

  const create = db.transaction(() => {
    if (erpOrder) mirrorErpReservation(resolved);
    else reserve(resolved);
    const info = db.prepare(`INSERT INTO orders (customer_id, status, total_cents, currency, ship_name, ship_street,
                             ship_house_number, ship_postal_code, ship_city, ship_country_code, erp_order_id, erp_order_number,
                             erp_connector) VALUES (?, 'NEW', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(customer.id, total, currency, customer.name, customer.street, customer.house_number,
           customer.postal_code, customer.city, customer.country_code, erpOrder?.id ?? null, erpOrder?.number ?? null,
           erpOrder?.connector ?? null);
    const insItem = db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price_cents, quantity, item_total_cents)
                                VALUES (?, ?, ?, ?, ?, ?)`);
    for (const { product, quantity } of resolved)
      insItem.run(info.lastInsertRowid, product.id, product.name, product.price_cents, quantity, product.price_cents * quantity);
    return info.lastInsertRowid;
  });

  const orderId = create();
  if (erpOrder) refreshStockFromErp();
  res.status(201).json(orderToApi(loadOrder(orderId, req.user)));
});

router.get('/', requireAuth, (req, res) => {
  const all = req.query.all === 'true' && req.user.role === 'admin';
  const rows = all
    ? db.prepare(`${ORDER_SELECT} ORDER BY o.id DESC`).all()
    : db.prepare(`${ORDER_SELECT} WHERE o.customer_id = ? ORDER BY o.id DESC`).all(req.user.id);
  res.json(rows.map(orderToApi));
});

router.get('/:id', requireAuth, (req, res) => {
  res.json(orderToApi(loadOrder(req.params.id, req.user)));
});

async function setStatus(order, status) {
  if (!ORDER_STATUSES.includes(status)) throw httpError(400, `Status must be one of ${ORDER_STATUSES.join(', ')}.`);
  if (order.status === 'CANCELED') throw httpError(409, 'Canceled orders cannot be changed.');
  if (status === order.status) return;

  if (order.erp_order_id) await setErpOrderStatus(order, status);

  db.transaction(() => {
    if (status === 'CANCELED' && !order.erp_order_id) {
      release(db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ?').all(order.id));
    }
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, order.id);
  })();
  if (order.erp_order_id && status === 'CANCELED' && order.erp_connector === getActiveConnector()?.id) refreshStockFromErp();
}

router.patch('/:id/status', requireAdmin, async (req, res) => {
  const order = loadOrder(req.params.id, req.user);
  await setStatus(order, req.body.status);
  res.json(orderToApi(loadOrder(order.id, req.user)));
});

router.post('/:id/cancel', requireAuth, async (req, res) => {
  const order = loadOrder(req.params.id, req.user);
  if (order.status !== 'NEW') throw httpError(409, 'Only new orders can be canceled.');
  await setStatus(order, 'CANCELED');
  res.json(orderToApi(loadOrder(order.id, req.user)));
});

export default router;
