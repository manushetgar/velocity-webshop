// =====================================================================================================
// inventory.js - all stock operations of the web shop on the local SQLite `products.stock` column.
//
// Role in the architecture:
//  - Standalone mode (no SAP connector active): the shop itself is responsible for stock. reserve() checks and
//    decrements it at checkout, release() puts it back when an order is canceled.
//  - ERP mode (SAP connector active): the Mini-ERP owns the stock and has already checked / reduced it when the
//    order was created there (erpOrders.js). mirrorErpReservation() only copies that change into the local
//    copy; the next product sync overwrites the local value with the ERP's value anyway.
//  - Used by routes/orders.js (reserve, mirrorErpReservation, release) and routes/products.js (getStock).
//  - The original Lab 1 note below describes the planned Lab 3 change. In this version the ERP-first logic lives in
//    erpOrders.js (the ERP checks and reduces its stock), and this module only mirrors that change locally.
// =====================================================================================================

// Shared better-sqlite3 connection. Its calls are synchronous, so they can run inside db.transaction().
import { db } from '../db.js';

/**
 * Inventory service - the single place that knows where stock lives.
 *
 * Lab 1: stock is kept in the local `products` table.
 * Lab 3: the ERP becomes the source of truth. Replace the bodies of
 *        getStock() and reserve() with RPC calls to the ERP; the routes
 *        that use this module do not need to change.
 */

// Current stock of a product, by its shop database id (products.id, not the business key productID).
// Used by productToApi() in routes/products.js to show the stock in the shop.
export function getStock(productDbId) {
  // Prepared SELECT with a bound parameter; .get() returns the first row or undefined.
  const row = db.prepare('SELECT stock FROM products WHERE id = ?').get(productDbId);
  // Unknown product -> 0 (nothing can be sold), otherwise the stored stock.
  return row ? row.stock : 0;
}

/**
 * Checks that every line can be fulfilled and decrements stock.
 * Must be called inside a DB transaction. Throws on insufficient stock.
 */
// `lines` = [{ product: <products row>, quantity }]. Used in standalone mode (no ERP) at checkout.
export function reserve(lines) {
  // Conditional UPDATE: "decrement by ?, but only if at least ? are in stock". Check and decrement happen in ONE
  // atomic SQL statement, so there is no gap between reading and writing in which another order could take the
  // same items (no overselling). Placeholders: quantity, product id, quantity.
  const dec = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?');
  // One UPDATE per cart line (destructuring takes product and quantity out of each line object).
  for (const { product, quantity } of lines) {
    // Execute the UPDATE; the result object tells how many rows were changed.
    const result = dec.run(quantity, product.id, quantity);
    // 0 changed rows = the WHERE condition `stock >= quantity` was false -> not enough stock.
    if (result.changes === 0) {
      // Readable error message with the currently available stock (shown to the customer).
      const err = new Error(`Not enough stock for "${product.name}" (available: ${getStock(product.id)}).`);
      // 409 Conflict - the central error handler in index.js uses err.status for the HTTP response.
      err.status = 409;
      // Throwing inside the caller's transaction rolls back ALL changes of this checkout (also the stock that was
      // already decremented for earlier lines), so either the whole order is reserved or nothing.
      throw err;
    }
  }
}

/**
 * Lab 3 mode: the ERP has already checked and reduced its stock.
 * Mirror the change locally so the shop shows it immediately (the next sync overwrites it with ERP values).
 */
// Called inside the checkout transaction after createErpOrder() succeeded. Unlike reserve() it never fails:
// the ERP (the master) has already accepted the order, so the local copy must simply follow.
export function mirrorErpReservation(lines) {
  // MAX(stock - ?, 0) is SQLite's scalar MAX (largest of its arguments): it clamps the result at 0. The local copy
  // may be older than the ERP's value, and a negative value would violate the column's CHECK (stock >= 0).
  const dec = db.prepare('UPDATE products SET stock = MAX(stock - ?, 0) WHERE id = ?');
  // One UPDATE per cart line: subtract the ordered quantity from the local copy.
  for (const { product, quantity } of lines) dec.run(quantity, product.id);
}

/** Puts stock back, e.g. when an order is canceled. */
// Used only for local (non-ERP) orders: for ERP orders the shop does not change the stock itself - after the ERP's
// cancelOrder action it refreshes its copy from the ERP (the master) with a product sync (routes/orders.js).
export function release(lines) {
  // Increment the stock of a product by the given quantity.
  const inc = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
  // `lines` are order_items rows; their product_id column is the shop's products.id (foreign key, INTEGER),
  // not the business key productID - so it can be used directly in WHERE id = ?.
  for (const { product_id, quantity } of lines) inc.run(quantity, product_id);
}
