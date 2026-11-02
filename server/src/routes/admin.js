import { Router } from 'express';
import { db } from '../db.js';
import { requireAdmin } from '../auth.js';
import { visibleProductsFilter } from './products.js';

const router = Router();
router.use(requireAdmin);

router.get('/stats', (_req, res) => {
  const one = sql => db.prepare(sql).get();
  const f = visibleProductsFilter();
  res.json({
    products: db.prepare(`SELECT COUNT(*) AS n FROM products WHERE active = 1 AND ${f.sql}`).get(...f.params).n,
    lowStock: db.prepare(`SELECT id, product_id AS productId, name, stock FROM products
                          WHERE active = 1 AND stock <= 5 AND ${f.sql} ORDER BY stock, name`).all(...f.params),
    customers: one("SELECT COUNT(*) AS n FROM customers WHERE role = 'customer'").n,
    orders: one('SELECT COUNT(*) AS n FROM orders').n,
    openOrders: one("SELECT COUNT(*) AS n FROM orders WHERE status IN ('NEW', 'PICKED', 'SHIPPED')").n,
    revenue: one("SELECT COALESCE(SUM(total_cents), 0) AS s FROM orders WHERE status <> 'CANCELED'").s / 100,
    ordersInErp: one('SELECT COUNT(*) AS n FROM orders WHERE erp_order_id IS NOT NULL').n,
    byStatus: Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all().map(r => [r.status, r.n])),
  });
});

router.get('/customers', (_req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.name, c.email, c.role, c.city, c.postal_code, c.created_at, c.erp_customer_id IS NOT NULL AS erp,
           COUNT(o.id) AS orders,
           COALESCE(SUM(CASE WHEN o.status <> 'CANCELED' THEN o.total_cents END), 0) AS spent_cents,
           MAX(o.order_date) AS last_order
    FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
    GROUP BY c.id ORDER BY c.role, c.name`).all();
  res.json(rows.map(r => ({
    id: r.id, name: r.name, email: r.email, role: r.role, city: r.city ? `${r.postal_code || ''} ${r.city}`.trim() : '',
    memberSince: r.created_at, erpCustomer: !!r.erp, orders: r.orders, spent: r.spent_cents / 100, lastOrder: r.last_order,
  })));
});

export default router;
