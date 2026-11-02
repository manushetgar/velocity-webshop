import { db } from '../db.js';

export function getStock(productDbId) {
  const row = db.prepare('SELECT stock FROM products WHERE id = ?').get(productDbId);
  return row ? row.stock : 0;
}

export function reserve(lines) {
  const dec = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?');
  for (const { product, quantity } of lines) {
    const result = dec.run(quantity, product.id, quantity);
    if (result.changes === 0) {
      const err = new Error(`Not enough stock for "${product.name}" (available: ${getStock(product.id)}).`);
      err.status = 409;
      throw err;
    }
  }
}

export function mirrorErpReservation(lines) {
  const dec = db.prepare('UPDATE products SET stock = MAX(stock - ?, 0) WHERE id = ?');
  for (const { product, quantity } of lines) dec.run(quantity, product.id);
}

export function release(lines) {
  const inc = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
  for (const { product_id, quantity } of lines) inc.run(quantity, product_id);
}
