import { Router } from 'express';
import { db, DEMO_ACCOUNTS } from '../db.js';
import { hashPassword, verifyPassword, createSession, deleteSession, requireAuth } from '../auth.js';
import { httpError } from '../util.js';
import { erpOrdersEnabled, ensureErpCustomer } from '../services/erpOrders.js';
import { updateCustomerInErp } from '../services/erpMasterData.js';

const router = Router();

router.get('/demo-accounts', (_req, res) => {
  if (process.env.DEMO_MODE === 'false') return res.json([]);
  const showAdmin = process.env.DEMO_SHOW_ADMIN !== 'false' && process.env.NODE_ENV !== 'production';
  res.json(DEMO_ACCOUNTS
    .filter(a => a.role !== 'admin' || showAdmin)
    .map(({ role, name, email, password }) => ({ role, name, email, password })));
});

const ADDRESS_FIELDS = ['street', 'houseNumber', 'postalCode', 'city', 'countryCode'];

export function customerToApi(c) {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    role: c.role,
    phone: c.phone || '',
    memberSince: c.created_at,
    erpCustomer: !!c.erp_customer_id,
    address: {
      street: c.street || '',
      houseNumber: c.house_number || '',
      postalCode: c.postal_code || '',
      city: c.city || '',
      countryCode: c.country_code || 'DE',
    },
  };
}

function validEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function cleanAddress(address) {
  if (address === null || typeof address !== 'object') throw httpError(400, 'Address must be an object.');
  const a = {};
  for (const f of ADDRESS_FIELDS) {
    const v = address[f];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') throw httpError(400, `Address field ${f} must be text.`);
    a[f] = v.trim().slice(0, 100);
  }
  if (a.countryCode !== undefined) {
    a.countryCode = (a.countryCode || 'DE').toUpperCase();
    if (!/^[A-Z]{2}$/.test(a.countryCode)) throw httpError(400, 'Country must be a 2-letter ISO code (e.g. DE).');
  }
  return a;
}

const isText = v => typeof v === 'string';

router.post('/auth/register', async (req, res) => {
  const { name, email, password, phone } = req.body;
  if (!isText(name) || !name.trim()) throw httpError(400, 'Name is required.');
  if (!validEmail(email)) throw httpError(400, 'A valid e-mail is required.');
  if (!isText(password) || password.length < 6) throw httpError(400, 'Password must have at least 6 characters.');
  if (phone !== undefined && phone !== null && !isText(phone)) throw httpError(400, 'Phone must be text.');
  const address = cleanAddress(req.body.address ?? {});
  if (db.prepare('SELECT 1 FROM customers WHERE email = ?').get(email)) throw httpError(409, 'E-mail is already registered.');

  const info = db.prepare(`INSERT INTO customers (name, email, password_hash, phone, street, house_number, postal_code, city, country_code)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(name.trim(), email.trim(), hashPassword(password), phone?.trim() || null, address.street ?? null,
         address.houseNumber ?? null, address.postalCode ?? null, address.city ?? null, address.countryCode || 'DE');
  let customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid);

  if (erpOrdersEnabled()) {
    try {
      await ensureErpCustomer(customer);
      customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customer.id);
    } catch (e) {
      console.warn('[erp] customer not created in ERP yet:', e.message);
    }
  }
  res.status(201).json({ token: createSession(customer.id), user: customerToApi(customer) });
});

router.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  const customer = isText(email) && db.prepare('SELECT * FROM customers WHERE email = ?').get(email);
  if (!customer || !isText(password) || !verifyPassword(password, customer.password_hash))
    throw httpError(401, 'Wrong e-mail or password.');
  res.json({ token: createSession(customer.id), user: customerToApi(customer) });
});

router.post('/auth/logout', requireAuth, (req, res) => {
  deleteSession(req.token);
  res.status(204).end();
});

router.get('/me', requireAuth, (req, res) => {
  res.json(customerToApi(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.user.id)));
});

router.put('/me', requireAuth, async (req, res) => {
  const current = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.user.id);
  const { name, email, phone, currentPassword, newPassword } = req.body;

  if (name !== undefined && (!isText(name) || !name.trim())) throw httpError(400, 'Name cannot be empty.');
  if (email !== undefined && !validEmail(email)) throw httpError(400, 'A valid e-mail is required.');
  if (phone !== undefined && phone !== null && !isText(phone)) throw httpError(400, 'Phone must be text.');
  const a = cleanAddress(req.body.address ?? {});
  if (email && email.toLowerCase() !== current.email.toLowerCase() &&
      db.prepare('SELECT 1 FROM customers WHERE email = ?').get(email))
    throw httpError(409, 'E-mail is already registered.');

  let passwordHash = current.password_hash;
  if (newPassword) {
    if (!isText(newPassword)) throw httpError(400, 'New password must be text.');
    if (!isText(currentPassword) || !verifyPassword(currentPassword, current.password_hash)) throw httpError(400, 'Current password is wrong.');
    if (newPassword.length < 6) throw httpError(400, 'New password must have at least 6 characters.');
    passwordHash = hashPassword(newPassword);
  }

  db.prepare(`UPDATE customers SET name = ?, email = ?, password_hash = ?, phone = ?, street = ?, house_number = ?,
              postal_code = ?, city = ?, country_code = ? WHERE id = ?`)
    .run(
      name?.trim() ?? current.name, email?.trim() ?? current.email, passwordHash, phone === undefined ? current.phone : phone?.trim() || null,
      a.street ?? current.street, a.houseNumber ?? current.house_number, a.postalCode ?? current.postal_code,
      a.city ?? current.city, a.countryCode ?? current.country_code, current.id,
    );
  const updated = db.prepare('SELECT * FROM customers WHERE id = ?').get(current.id);

  let erpWarning;
  try {
    await updateCustomerInErp(updated);
  } catch (e) {
    erpWarning = `Saved in the shop, but the ERP could not be updated: ${e.message}`;
  }
  res.json({ ...customerToApi(updated), erpWarning });
});

export default router;
