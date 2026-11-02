// Must stay first: loads server/.env before other modules read process.env.
import './env.js';
import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import './db.js';
import { optionalAuth } from './auth.js';
import productRoutes from './routes/products.js';
import customerRoutes from './routes/customers.js';
import orderRoutes from './routes/orders.js';
import erpRoutes from './routes/erp.js';
import adminRoutes from './routes/admin.js';
import { getActiveConnector } from './services/connectors.js';
import { startBackgroundSync } from './services/erpSync.js';
import fileTransferRoutes from './routes/fileTransfer.js';
import { startInboxPoller } from './services/fileTransfer.js';
import supplierRoutes from './routes/suppliers.js';
import { createPortalApp } from './portal/portal.js';
import { startFtpServer } from './services/ftpServer.js';
import { startSupplierPoller } from './services/supplierImport.js';

const app = express();
const PORT = Number(process.env.PORT || 3001);

app.use(express.json());
// Express 5 leaves req.body undefined for requests without a JSON body.
app.use((req, _res, next) => { req.body ??= {}; next(); });
app.use(optionalAuth);

app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.use('/api/products', productRoutes);
app.use('/api', customerRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/erp', erpRoutes);
app.use('/api/erp/files', fileTransferRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/admin', adminRoutes);
const portalApp = createPortalApp();
app.get('/portal', (req, res, next) => (req.originalUrl.split('?')[0] === '/portal' ? res.redirect('/portal/') : next()));
app.use('/portal', portalApp);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

const clientDist = join(dirname(fileURLToPath(import.meta.url)), '../../client/dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // Express 5 rejects a bare '*' path, hence the regex for the SPA fallback.
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(clientDist, 'index.html')));
}

app.use((err, _req, res, _next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Internal server error.' : err.message });
});

app.listen(PORT, err => {
  if (err) {
    console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Stop the other process or set PORT.` : err);
    process.exit(1);
  }
  console.log(`Web shop API running on http://localhost:${PORT}`);
  const conn = getActiveConnector();
  console.log(conn
    ? `[erp] active SAP connector: ${conn.name} (${conn.url}, ${conn.auth} auth) - change it in Admin > SAP connectors`
    : '[erp] no SAP connector active - the shop runs standalone with its local products');
  startBackgroundSync();
  startInboxPoller();
  const portalPort = Number(process.env.PORTAL_PORT ?? 3200);
  if (portalPort) {
    portalApp.listen(portalPort, e => console.log(e
      ? `[portal] port ${portalPort} is not available (${e.code || e.message}) - the portal is still reachable under /portal/`
      : `[portal] supplier portal running on http://localhost:${portalPort}`));
  }
  startFtpServer();
  startSupplierPoller();
});
