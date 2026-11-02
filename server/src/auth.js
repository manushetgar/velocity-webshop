import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { db } from './db.js';

const TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 24);

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

export function createSession(customerId) {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + TTL_HOURS * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, customer_id, expires_at) VALUES (?, ?, ?)').run(token, customerId, expires);
  return token;
}

export function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function tokenFrom(req) {
  const h = req.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

export function optionalAuth(req, _res, next) {
  const token = tokenFrom(req);
  if (token) {
    const row = db.prepare(`
      SELECT c.id, c.name, c.email, c.role FROM sessions s JOIN customers c ON c.id = s.customer_id
      WHERE s.token = ? AND s.expires_at > ?`).get(token, new Date().toISOString());
    if (row) {
      req.user = row;
      req.token = token;
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in first.' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in first.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin rights required.' });
  next();
}
