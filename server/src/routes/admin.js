// ---------------------------------------------------------------------------------------------------------------
// routes/admin.js - read-only reporting endpoints of the admin area, mounted under /api/admin in index.js:
//   GET /api/admin/stats      key figures for the admin dashboard (products, low stock, customers, orders, revenue)
//   GET /api/admin/customers  customer list with purchase figures (number of orders, amount spent, last order)
// All figures are calculated from the shop's own SQLite database (no ERP call), so the dashboard also works while the
// ERP is unreachable. Product data and stock in that database are the synchronized copy of the ERP's master data.
// Product maintenance, order handling and the SAP connectors are in routes/products.js, orders.js and erp.js.
// ---------------------------------------------------------------------------------------------------------------

// Router: Express' "mini application" - a group of routes that is mounted at a path prefix in index.js
// (app.use('/api/admin', adminRoutes)); the paths below are relative to that prefix.
import { Router } from 'express';
// The shared SQLite connection (better-sqlite3); all statistics are SQL queries on the shop database.
import { db } from '../db.js';
// Guard middleware: only logged-in users with role 'admin' may continue (otherwise 401 / 403).
import { requireAdmin } from '../auth.js';
// Returns an SQL condition that limits the products to those of the active SAP connector (or all products when the
// shop runs standalone), so the dashboard counts the same products the shop shows.
import { visibleProductsFilter } from './products.js';

// Creates the router object that collects the admin routes; it is exported at the end of the file.
const router = Router();
// router.use(middleware) runs requireAdmin before EVERY route of this router. Customer data and revenue are
// confidential, so the whole /api/admin area is protected in one place instead of repeating it on each route.
router.use(requireAdmin);

// Key figures for the admin dashboard
// GET /api/admin/stats - synchronous handler: better-sqlite3 queries are synchronous, no await needed.
// `_req` is unused (the endpoint has no parameters).
router.get('/stats', (_req, res) => {
  // Small helper: prepares an SQL statement without parameters and returns its single result row (.get()).
  // Used for the COUNT / SUM queries below, each of which returns exactly one row.
  const one = sql => db.prepare(sql).get();
  // f = { sql, params }: f.sql is a fixed SQL fragment ('erp_connector = ?' or '1 = 1', always true),
  // f.params the matching bound values ([connector id] or []). The fragment is inserted into the SQL text, the
  // values are passed as bound parameters (...f.params) - so no user input ever becomes part of the SQL text.
  const f = visibleProductsFilter(); // products of the active SAP connector
  // Sends one JSON object with all key figures (HTTP 200); the admin dashboard of the React app displays them.
  res.json({
    // Number of products that the shop currently offers: active = 1 excludes soft-deleted products,
    // f.sql limits the count to the products of the active connector. .n is the alias of COUNT(*).
    products: db.prepare(`SELECT COUNT(*) AS n FROM products WHERE active = 1 AND ${f.sql}`).get(...f.params).n,
    // Low-stock list (warning for re-ordering): visible active products with 5 or fewer pieces in stock.
    // Columns: id, product_id renamed to productId (camelCase for the JSON API), name, stock.
    // ORDER BY stock, name: the most critical products (lowest stock, e.g. sold out = 0) first, then alphabetically.
    // .all() returns all matching rows as an array. With a connector, stock is the value synchronized from the ERP.
    lowStock: db.prepare(`SELECT id, product_id AS productId, name, stock FROM products
                          WHERE active = 1 AND stock <= 5 AND ${f.sql} ORDER BY stock, name`).all(...f.params),
    // Number of registered customers; admin accounts are not counted (role = 'customer' only).
    customers: one("SELECT COUNT(*) AS n FROM customers WHERE role = 'customer'").n,
    // Total number of orders in the shop database (all connectors and shop-only orders, all statuses).
    orders: one('SELECT COUNT(*) AS n FROM orders').n,
    // Open orders = still being processed: NEW (just ordered), PICKED (picked in the warehouse) or SHIPPED.
    // COMPLETED and CANCELED orders are finished. These status codes are the same as in the Mini-ERP.
    openOrders: one("SELECT COUNT(*) AS n FROM orders WHERE status IN ('NEW', 'PICKED', 'SHIPPED')").n,
    // Revenue: sum of all order totals except canceled orders (<> means "not equal" in SQL).
    // COALESCE(..., 0) returns 0 instead of NULL when there are no orders yet (SUM of zero rows is NULL).
    // .s is the alias of the sum; "/ 100" converts the stored cents into euros for the frontend.
    revenue: one("SELECT COALESCE(SUM(total_cents), 0) AS s FROM orders WHERE status <> 'CANCELED'").s / 100,
    // Orders that were handed over to the ERP: they have the ERP's order key (UUID) in erp_order_id.
    // With an active connector the checkout creates the order in the ERP first ("ERP first"); shop-only orders
    // (created while no connector was active) have NULL here.
    ordersInErp: one('SELECT COUNT(*) AS n FROM orders WHERE erp_order_id IS NOT NULL').n,
    // Number of orders per status, as an object such as { NEW: 3, SHIPPED: 1, COMPLETED: 5 }:
    //  - GROUP BY status returns one row { status, n } per status that occurs (statuses without orders are missing)
    //  - .map(r => [r.status, r.n]) turns every row into a [key, value] pair
    //  - Object.fromEntries(...) builds the object from these pairs
    byStatus: Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all().map(r => [r.status, r.n])),
  });
});

// Customer list with purchase figures
// GET /api/admin/customers - one entry per shop account (customers and admins) with order statistics.
router.get('/customers', (_req, res) => {
  // One SQL query calculates everything (instead of one query per customer):
  //  - c.id, c.name, c.email, c.role, c.city, c.postal_code, c.created_at: the account data from the shop database
  //  - c.erp_customer_id IS NOT NULL AS erp: 1 if the account is linked to a customer in an ERP (the link is set when
  //    the customer registers or orders while a connector is active, see ensureErpCustomer in
  //    services/erpOrders.js), otherwise 0
  //    (SQLite has no boolean type, conditions return 1 or 0)
  //  - COUNT(o.id) AS orders: number of orders; COUNT(column) ignores NULL values, so a customer without orders
  //    (whose LEFT JOIN columns are NULL) gets 0
  //  - COALESCE(SUM(CASE WHEN o.status <> 'CANCELED' THEN o.total_cents END), 0) AS spent_cents: total amount of all
  //    orders that are not canceled; the CASE without ELSE yields NULL for canceled orders, which SUM ignores, and
  //    COALESCE turns the NULL of "no orders at all" into 0
  //  - MAX(o.order_date) AS last_order: the date of the most recent order (NULL if there is none); the date text
  //    'YYYY-MM-DD HH:MM:SS' sorts chronologically, so MAX gives the newest one
  //  - FROM customers c LEFT JOIN orders o ON o.customer_id = c.id: combines every customer with his/her orders;
  //    LEFT JOIN keeps customers without any order (an INNER JOIN would drop them)
  //  - GROUP BY c.id: one result row per customer; COUNT/SUM/MAX are calculated per customer
  //  - ORDER BY c.role, c.name: 'admin' sorts before 'customer' alphabetically, then by name
  // .all() returns all rows as an array of objects.
  const rows = db.prepare(`
    SELECT c.id, c.name, c.email, c.role, c.city, c.postal_code, c.created_at, c.erp_customer_id IS NOT NULL AS erp,
           COUNT(o.id) AS orders,
           COALESCE(SUM(CASE WHEN o.status <> 'CANCELED' THEN o.total_cents END), 0) AS spent_cents,
           MAX(o.order_date) AS last_order
    FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
    GROUP BY c.id ORDER BY c.role, c.name`).all();
  // Converts every database row (snake_case column names, cents, 0/1) into the JSON format of the API
  // (camelCase names, euros, true/false) and sends the array (HTTP 200). The password hash is never selected.
  res.json(rows.map(r => ({
    // id, name, email, role are passed through unchanged. city: postal code and city combined, e.g. "52064 Aachen";
    // `|| ''` avoids "null" for a missing postal code and trim() removes the leading space then; '' without a city.
    id: r.id, name: r.name, email: r.email, role: r.role, city: r.city ? `${r.postal_code || ''} ${r.city}`.trim() : '',
    // memberSince: registration time; erpCustomer: !! converts SQLite's 1/0 into true/false; orders: order count;
    // spent: amount in euros (cents / 100); lastOrder: date of the newest order or null.
    memberSince: r.created_at, erpCustomer: !!r.erp, orders: r.orders, spent: r.spent_cents / 100, lastOrder: r.last_order,
  })));
});

// Default export: index.js imports this router as `adminRoutes` and mounts it with app.use('/api/admin', adminRoutes).
export default router;
