import { db } from '../db.js';
import { clientFor, requireActiveConnector } from './erpClient.js';
import { getActiveConnector } from './connectors.js';
import { CATALOG } from '../catalog.js';
import { syncProductsFromErp } from './productSync.js';

const toErpProduct = p => ({
  productID: p.productId.toUpperCase(),
  name: p.name,
  description: p.description || null,
  price: Number(p.price),
  currency_code: p.currency || 'EUR',
  stock: Number(p.stock || 0),
});

export async function createProductInErp(input, conn = requireActiveConnector()) {
  const created = await clientFor(conn).createProduct(toErpProduct(input));
  await syncProductsFromErp(conn);
  return db.prepare('SELECT * FROM products WHERE erp_id = ? AND erp_connector = ?').get(created.ID, conn.id);
}

export async function updateProductInErp(erpId, changes, conn = requireActiveConnector()) {
  const body = {};
  if (changes.name !== undefined) body.name = changes.name;
  if (changes.description !== undefined) body.description = changes.description || null;
  if (changes.price !== undefined) body.price = Number(changes.price);
  if (changes.stock !== undefined && changes.stock !== '') body.stock = Number(changes.stock);
  if (Object.keys(body).length) await clientFor(conn).updateProduct(erpId, body);
  await syncProductsFromErp(conn);
}

export async function updateCustomerInErp(customer) {
  const conn = getActiveConnector();
  if (!conn || !customer.erp_customer_id || customer.erp_connector !== conn.id) return;
  if (conn.integration === 'file') return;
  await clientFor(conn).updateCustomer(customer.erp_customer_id, {
    name: customer.name, email: customer.email, street: customer.street, houseNumber: customer.house_number,
    city: customer.city, postalCode: customer.postal_code, country_code: customer.country_code || 'DE',
  });
}

export async function loadCatalogIntoErp(conn = requireActiveConnector(), { syncShop = true } = {}) {
  const api = clientFor(conn);
  const items = await api.products();
  const existing = new Map(items.map(p => [String(p.productID).toUpperCase(), p]));
  const result = { created: 0, completed: 0, existing: 0 };
  for (const item of CATALOG) {
    const current = existing.get(item.productID);
    if (!current) {
      await api.createProduct(toErpProduct({ ...item, productId: item.productID }));
      result.created++;
    } else if (!current.description) {
      await api.updateProduct(current.ID, { description: item.description });
      result.completed++;
    } else {
      result.existing++;
    }
  }
  if (!syncShop) return result;
  result.products = await syncProductsFromErp(conn, result.created || result.completed ? null : items);
  return result;
}
