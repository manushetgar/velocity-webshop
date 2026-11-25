import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CATALOG } from '../src/catalog.js';

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function auth(token, body) {
  return {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function fakeErp(products) {
  const state = { mode: 'ok', productFailures: 0, orderAttempts: 0, customers: [], pendingOrders: [] };
  let nextOrder = 1000;

  async function completeOrder(batch, stockByProduct) {
    if (state.pendingOrders.length < 2) return;
    const pending = state.pendingOrders.splice(0);
    for (const attempt of pending) {
      const body = attempt.body;
      const item = body.items[0];
      const product = stockByProduct.get(item.product_ID);
      if (!product || product.stock < item.quantity) {
        json(attempt.res, 422, {
          error: { code: 'OUT_OF_STOCK', message: `Not enough stock for "${product?.name || item.product_ID}" (available: ${product?.stock ?? 0}).` },
        });
        continue;
      }
      product.stock -= item.quantity;
      json(attempt.res, 201, { ID: `order-${++nextOrder}`, orderID: nextOrder, ...body });
    }
    assert.equal(state.pendingOrders.length, 0, batch);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://erp.test');
    const path = url.pathname;
    if (path === '/rest/api/products()' && req.method === 'GET') {
      if (state.productFailures > 0) {
        state.productFailures--;
        return json(res, 500, { error: { message: 'temporary ERP failure' } });
      }
      if (state.mode === 'invalid-json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{bad json');
      }
      if (state.mode === 'timeout') return;
      return json(res, 200, products.map(p => ({ ...p })));
    }
    if (path.endsWith('/Products') && url.searchParams.has('$select') && req.method === 'GET')
      return json(res, 200, { value: products.map(p => ({ ID: p.ID, createdBy: '' })) });
    if (path.endsWith('/Orders') && url.searchParams.has('$select') && req.method === 'GET')
      return json(res, 200, { value: [] });
    if (path.endsWith('/Customers') && req.method === 'GET')
      return json(res, 200, { value: state.customers.filter(c => url.search.includes(encodeURIComponent(c.email))) });

    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (path.endsWith('/Customers') && req.method === 'POST') {
        const customer = { ID: `customer-${state.customers.length + 1}`, ...body };
        state.customers.push(customer);
        return json(res, 201, customer);
      }
      if (path.endsWith('/Orders') && req.method === 'POST') {
        state.orderAttempts++;
        state.pendingOrders.push({ res, body });
        if (state.orderAttempts === 2) {
          const stockByProduct = new Map(products.map(p => [p.ID, p]));
          return completeOrder('concurrent order batch did not drain', stockByProduct);
        }
        return;
      }
      json(res, 404, { error: { message: 'Unknown fake ERP route' } });
    });
  });
  return { server, state };
}

test('Lab 3 RPC checkout and failure behavior', { timeout: 20_000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'velocity-lab3-'));
  const erpProducts = CATALOG.map((p, index) => ({
    ID: `erp-${index + 1}`,
    productID: p.productID,
    name: p.name,
    description: p.description,
    price: p.price,
    currency: 'EUR',
    stock: index === 0 ? 1 : 20,
  }));
  const { server: erpServer, state } = fakeErp(erpProducts);
  const erpPort = await listen(erpServer);
  const appServerPort = 39000 + Math.floor(Math.random() * 5000);
  const output = [];
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(appServerPort),
      DB_FILE: join(temp, 'webshop.db'),
      LOCAL_ERP_URL: `http://127.0.0.1:${erpPort}`,
      LOCAL_ERP_USER: 'service-user',
      LOCAL_ERP_PASSWORD: 'service-user',
      ERP_ACTIVE: 'local',
      ERP_TIMEOUT_MS: '80',
      ERP_SYNC_ON_START: 'false',
      ERP_SYNC_INTERVAL_S: '0',
      FILE_POLL_INTERVAL_S: '0',
      PORTAL_PORT: '0',
      FTP_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => output.push(String(chunk)));
  child.stderr.on('data', chunk => output.push(String(chunk)));

  t.after(async () => {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    erpServer.closeAllConnections?.();
    await new Promise(resolve => erpServer.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${appServerPort}`;
  let started = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const health = await request(`${base}/api/health`);
      if (health.status === 200) { started = true; break; }
    } catch {}
    if (child.exitCode !== null) assert.fail(`Shop server exited early:\n${output.join('')}`);
    await wait(50);
  }
  assert.ok(started, `Shop server did not start on port ${appServerPort}:\n${output.join('')}`);

  const users = await Promise.all(['one', 'two'].map(async suffix => {
    const response = await request(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Test User ${suffix}`, email: `test-${suffix}@example.test`, password: 'secret12',
        address: { street: 'Test Street', houseNumber: '1', postalCode: '52064', city: 'Aachen', countryCode: 'DE' },
      }),
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.token;
  }));

  const catalog = await request(`${base}/api/products`);
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
  const oneLeft = catalog.body.find(p => p.productId === CATALOG[0].productID);
  assert.equal(oneLeft.stock, 1);

  const invalid = await request(`${base}/api/orders`, auth(users[0], { items: [{ productId: 'bad', quantity: 1 }] }));
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /valid product ID/);

  const [first, second] = await Promise.all(users.map(token =>
    request(`${base}/api/orders`, auth(token, { items: [{ productId: oneLeft.id, quantity: 1 }] }))));
  assert.deepEqual([first.status, second.status].sort(), [201, 422]);
  const rejected = first.status === 422 ? first : second;
  assert.match(rejected.body.error, /Not enough stock|out of stock/i);
  assert.equal(erpProducts[0].stock, 0);
  const afterCheckout = await request(`${base}/api/products`);
  assert.equal(afterCheckout.body.find(p => p.id === oneLeft.id).stock, 0);

  state.productFailures = 1;
  const retried = await request(`${base}/api/products`);
  assert.equal(retried.status, 200, 'a transient 500 read should be retried');

  state.mode = 'invalid-json';
  const malformed = await request(`${base}/api/products`);
  assert.equal(malformed.status, 502);
  assert.match(malformed.body.error, /invalid JSON/);

  state.mode = 'timeout';
  const timedOut = await request(`${base}/api/products`);
  assert.equal(timedOut.status, 503);
  assert.match(timedOut.body.error, /timeout|not reachable/i);

  state.mode = 'ok';
  erpServer.closeAllConnections?.();
  await new Promise(resolve => erpServer.close(() => resolve()));
  const unavailable = await request(`${base}/api/products`);
  assert.equal(unavailable.status, 503);
  assert.match(unavailable.body.error, /not reachable/i);
});
