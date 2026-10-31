# VeloCity Bike Shop – Lab 1: Simple Web Shop · Lab 2: File Transfer

Systems Integration, FH Aachen, Winter Term 2026/27.

A web shop for bikes and gear that manages **products**, **customers** and **orders** and is
integrated with the course's **Mini-ERP** (SAP CAP) – locally or on **SAP BTP** (HANA Cloud, XSUAA).

## Stack

| Part      | Technology |
|-----------|------------|
| Frontend  | React 19, React Router 7, Vite 7 (plain CSS, no UI library) |
| Backend   | Node.js 22, Express 5 (REST API) |
| Database  | SQLite (better-sqlite3) |
| Security  | bcrypt password hashes, server-side session tokens, admin/customer roles |
| ERP       | Mini-ERP (SAP CAP): REST + OData v4, OAuth 2.0 client credentials (XSUAA) on SAP BTP, basic auth locally |

## Run it

Requires Node.js 22 LTS (22.12 or newer). On Windows PowerShell use `npm.cmd` instead of `npm`.

```bash
npm install          # installs server + client (npm workspaces)
npm run dev          # API on :3001, React dev server on :5173
```

Open http://localhost:5173. Production-like: `npm run build && npm start` (everything on :3001).
`npm run reset-db` deletes the shop database; demo data is recreated on the next start.
Step-by-step instructions (also for the ERP and SAP BTP): `HOW-TO-RUN.txt`; background and design decisions:
`docs/Lab0-Guide-MiniERP-SAP-BTP.pdf` and `docs/Lab1-Guide-VeloCity-Web-Shop.pdf`.

### Demo accounts

Created automatically on first start and shown on the login page (values in `server/.env.example`):

| Role | Use it for |
|---|---|
| Administrator | Admin area: dashboard, products, orders, customers, SAP connectors |
| Customer (Max Mustermann) | Shopping, checkout, purchase history, profile |

New customers can register themselves.

### Connect to the Mini-ERP (SAP connectors)

The shop talks to the ERP through **SAP connectors** (*Admin › SAP connectors*). Exactly one connector
is active – the shop shows the products of that ERP and creates its orders there – or none (standalone
mode with local products and stock). Each connector card has *Test*, *Use this ERP*, *Edit* and *Delete*;
new ones are added with presets for the local ERP and SAP BTP, and the connection can be tested before saving.

Created on the first start:

| Connector | URL | Authentication |
|---|---|---|
| **Local SAP (cds watch)** – active by default | `http://localhost:4004` | basic auth, mocked user `service-user` |
| **SAP BTP (Cloud Foundry)** – if `ERP_URL` + `ERP_XSUAA_KEY_FILE` are set in `server/.env` | route of `simple-erp-srv` | OAuth 2.0 client credentials with the service key of `simple-erp-auth-api` |

Local ERP: start the Mini-ERP in its own folder with `cds watch` (before or after the shop). Its data
lives in memory and is reset on every restart, so this connector creates the 14 demo products in the
ERP automatically (*Demo catalog: created automatically*); the Mini-ERP itself ships with two.
For other connectors use *Load demo catalog*.

Sync: on start, when a connector is activated, on *Sync now*, every 60 s (`ERP_SYNC_INTERVAL_S`),
and right before every checkout. If the ERP is not reachable, the shop says so (admins see the error
and what to start) instead of showing outdated products.

## Lab 2: Transferring product information with files

*Admin › File transfer* switches the active connector from the API integration to a **file interface**
(also possible in the connector's *Edit* dialog: *Product data reaches the shop via*). The shop then
never calls the ERP to read products – the only link between the two systems is a folder:

```
SAP ERP (export job)                    server/transfer/                   web shop (import)
GET /rest/api/getProducts()  ──CSV──▶   inbox/      ── every 10 s ──▶     check name, format, every line
(the ERP's own CSV export)              processed/  ◀── imported files     update products (one transaction)
                                        error/      ◀── rejected files + <file>.error.txt
```

| Requirement | Implementation |
|---|---|
| Web shop file import | `services/productFile.js` reads the ERP's CSV export (`productID,name,description,price,stock`, price as `1200.00 EUR`) and the `.xlsx` of the Fiori app's *Export to Spreadsheet* button (Manage Products). A file is a **full snapshot**: new products are created, changed prices/stock/texts updated, products missing in the file are removed from the shop. |
| Export mechanism | Export job (simulates a job on the ERP server, runs inside the shop server for the lab): reads the ERP's CSV export and writes it as `.part`, then renames it (atomic) into `inbox/`. *Export from ERP now*, or scheduled. |
| Naming convention | `products_<source>_<YYYYMMDDTHHMMSSZ>[-n].csv` (or `.xlsx`) – source = connector id (`local`, `btp`) or `upload`, UTC time stamp, `-n` for two files in one second |
| Location | `FILE_TRANSFER_DIR` (default `server/transfer`) with `inbox/`, `processed/`, `error/` |
| Frequency | export every `ERP_SYNC_INTERVAL_S` (60 s) **only if the ERP data changed** (SHA-256 of the content), inbox polled every `FILE_POLL_INTERVAL_S` (10 s), on demand with *Export now*, *Import inbox now*, *Upload file*, *Sync now* |
| Error handling | rejected (moved to `error/` with a report, nothing imported – **all or nothing**): wrong file name, file of another ERP, already imported (duplicate), older than the last import (out of order), time stamp in the future, empty / not CSV / HTML error page / broken .xlsx, missing columns, duplicate product IDs, empty or invalid values (price, stock, lengths). Files still being copied are skipped until unchanged for 2 s. A failed export is logged once; the shop keeps the data of the last file. Every export/import is logged in `file_transfer_log` (*History*). |

Found during testing: the Mini-ERP's CSV export does **not quote** values, so a description with a comma
(e.g. *"… 29" wheels, air fork and …"*) adds a column. The importer repairs such lines (the extra
separators are joined back into the description – price and stock are still validated at the end of the
line) and reports it as a remark; a line that does not fit is rejected.

In file mode orders stay in the shop (like Lab 1): the shop reduces its own stock, the ERP does not know
about the order, and the next file brings the ERP's stock again – the classic consistency problem of
batch file interfaces, solved with RPC in Lab 3 (switch back to *API (live)*).

**Advantages:** loose coupling (the shop works while the ERP is down), simple, works with legacy systems,
files are an audit trail. **Limitations:** latency (minutes), no immediate feedback to the sender, full
files grow with the catalog, conflicting updates, manual handling of rejected files. **Improvements:**
SFTP/managed file transfer with acknowledgements (e.g. a `.done` file), delta files with change
timestamps, a checksum/manifest, notifications on errors, exporting orders back as files, or replacing
the batch interface with events/messaging.

## Lab 2 extension: suppliers deliver files in their own formats (portal + FTP)

A second file interface, this time **from outside**: supply chain partners deliver product data (new
products, prices, stock) in *their* formats. VeloCity translates every file, writes it into the SAP ERP
(the master) and the shop gets it from there – so the ERP never falls behind.

```
supplier employee ──▶ Supplier portal  http://localhost:3200  (separate site, own logins)  ─┐
supplier system   ──▶ FTP  ftp://127.0.0.1:2121  (same logins, /inbox and /outbox)          ─┤
                                                                                            ▼
                                server/transfer/suppliers/<id>/inbox   (the folder identifies the sender)
                                                                                            │ every 10 s / right after an upload
                    translate with the supplier's mapping profile, check every value (all or nothing)
                                                                                            │
     SAP ERP(s): OData POST /Products (new) · PATCH /Products(<id>) (changes) – Local, Cloud or both (admin setting)
                                                                                            │
          shop: API sync, or – in file transfer mode – a new ERP export file that the shop imports
                                                                                            │
          acknowledgement for the supplier: outbox/<file>.ack.txt or .error.txt (portal + FTP)
```

| Topic | Implementation |
|---|---|
| Formats | delimited text (`,` `;` TAB `\|`, UTF-8 or Windows-1252), Excel `.xlsx`, JSON (nested, JSON lines), XML (elements and attributes); old `.xls` is refused with a hint |
| Mapping | per supplier in *Admin › Suppliers* (format, separator, decimal sign, JSON path / XML element, field names). Empty fields are detected from usual names in English and German (SKU, Part Number, Artikelnummer, Unit Price, Preis, Qty Available, Bestand …). *Test with a file* shows the result without importing. |
| Values | decimal comma / point, thousands separators, currency codes and symbols (`12,90 €`, `EUR 1.299,00`), ERP limits (name 100, description 500, stock 0–1000), only shop currencies (`SHOP_CURRENCIES`, default EUR) |
| Rights | per supplier: which fields it may change on existing products (e.g. BikeParts: price + stock only) and whether it may create new products |
| Target ERP (local / cloud) | *Admin › Suppliers › Write supplier data to*: **Active connector** (default, follows the shop), **Local** (Mini-ERP on this computer), **Cloud** (Mini-ERP on SAP BTP / HANA Cloud) or **Both**. Each target ERP is planned and written on its own (`summary.targets` in the delivery: applied / unchanged / waiting / rejected). This shop syncs its active connector right away; the cloud shop on SAP BTP picks up changes in SAP BTP with its own ERP sync (every 60 s). |
| Both, one ERP down | the reachable ERP is written at once, the file stays in the inbox (*waiting*) only for the missing one and is completed automatically when it is back – a target that is done is never written twice; the file keeps the targets it started with. A problem that only one ERP reports (e.g. a product that exists only locally) rejects the file before anything is written; if an ERP refuses data after the other one was written, the result is *partial* (report in the acknowledgement). |
| Error handling | all or nothing per file; rejected files go to `error/` with a report in the supplier's `outbox/`; ERP not reachable or no connector active → status *waiting*, retried automatically (the writes are idempotent); a supplier file is a **delta** (missing products are not deleted, empty cells change nothing) |
| FTP | own minimal server (`services/ftpServer.js`, no dependency): plain FTP, passive mode, bound to 127.0.0.1, one chrooted folder per supplier, upload only into `/inbox`, written as `.part` and renamed, size limit, slowed down after wrong passwords. In production: SFTP/FTPS. |
| Demo | 4 suppliers, one per format: `bikeparts` (German CSV), `globalcycle` (JSON), `nordicgear` (XML), `celticparts` (Excel with its own English column names); password `SUPPLIER_DEMO_PASSWORD` (default `supplier123`). Sample files: `server/src/portal/samples/` (also *Download sample file* in the portal, plus `broken-bikeparts.csv` for the error handling). |

FileZilla: host `127.0.0.1`, port `2121`, user `bikeparts`, password as above; FileZilla warns that the
server does not support TLS (plain FTP, local demo) – accept it. Command line: `curl -T file.csv
ftp://bikeparts:<password>@127.0.0.1:2121/inbox/`.

Note for the local ERP (`cds watch`): it keeps its data in memory, so products created by suppliers are
gone after a restart of the ERP – deliver the files again.

## Deploy to SAP BTP (Cloud Foundry)

The shop runs as a second app next to the Mini-ERP in the same space. In the cloud it gets the
XSUAA credentials for the ERP API from a **service binding** (`simple-erp-auth-api`), so no key file
is uploaded.

```bash
npm run cf:build            # builds the React app and creates cf-dist/ (code + manifest.yml)
cd cf-dist
cf push                     # Node.js buildpack, binds simple-erp-auth-api
cf set-env velocity-webshop ADMIN_PASSWORD <password>
cf restart velocity-webshop
```

`cf:build` takes `ERP_URL` from `server/.env` and derives the route
(`<org>-<space>-simple-erp-srv` → `<org>-<space>-velocity-webshop`). The cf CLI is needed – or upload
`cf-dist/` to SAP Business Application Studio and run `cf push` there. In the cloud the connector list
contains only *SAP BTP*, and the login page shows only the demo customer (`DEMO_SHOW_ADMIN=false`).

Note: the shop database (SQLite) lives on the app container's disk and is reset when the app restarts
or is pushed again (customers registered in the shop, sessions, shop orders). Products, stock, ERP
orders and ERP customers are not affected – they live in the ERP (HANA Cloud). For permanent shop
data the next step would be a database service (e.g. an HDI container on HANA Cloud).

## Requirements → implementation

| Lab requirement | Implementation |
|---|---|
| Display a list of available products | Shop page with categories, search, sort, stock badges; product detail page |
| Add new products and remove existing ones | Admin › Products: create, edit, remove (soft delete) and restore |
| Product has name, description, price | + product ID (ERP key), category, currency, stock |
| Customers register, log in, update personal info | Register page, login (demo accounts), My account › Profile & address, password change |
| Customer has name, e-mail, address, purchase history | `customers` table (address split like the ERP), My account › Purchase history |
| Create orders by adding products and checking out | Cart → Checkout (address + review) → Confirmation |
| Order stores customer, products, quantities, total, status | `orders` + `order_items`, status NEW → PICKED → SHIPPED → COMPLETED / CANCELED |

## ERP integration (what is mastered where)

| Data | Master | How |
|---|---|---|
| Products, prices, stock | ERP | REST `/rest/api/products()` of the active connector, synced on start, on demand and every minute; admin changes are written to the ERP first (OData `POST`/`PATCH /Products`) |
| Orders | ERP | OData `POST /Orders` at checkout – the ERP checks and reduces stock; status changes via ERP actions `pickOrder`, `shipOrder`, `completeOrder`, `cancelOrder` in the ERP the order was created in; status changes made in the ERP are synced back |
| Customers | Shop + ERP | Found by e-mail or created in the active ERP at registration (or first order), profile changes are patched |
| Connectors | Shop | `erp_connectors` table; products, customers and orders remember which ERP their ERP key belongs to (`erp_connector`) |
| Passwords, sessions, cart, categories | Shop | SQLite only |

Known ERP issue: the Mini-ERP's `cancelOrder` always answers *"Cannot cancel an order that is not in
new state"* (`srv/simpleerp.js` compares the selected row object with the string `"NEW"`), so ERP
orders cannot be canceled until that is fixed in the ERP.

## Design decisions

1. **Data model aligned with the ERP** (product ID as business key, address fields, status codes) – trivial mappings.
2. **ERP is the source of truth** for products, stock and orders; the shop keeps a synchronised copy for fast reads.
3. **ERP first, shop second** at checkout: no shop order without an ERP order, the ERP decides about stock.
4. **Order creation is never retried automatically** (non-idempotent POST); reads are retried with backoff and timeouts.
5. **Order + order items with price snapshots**; money stored as integer cents.
6. **Checkout in one DB transaction**; local mode uses a conditional stock update, so the last item cannot be sold twice.
7. **Soft delete** for products: purchase history stays complete, the product stays in the ERP.
8. **Server-side sessions** (revocable) and **bcrypt** hashes; role-based access for admin endpoints.
9. **SQLite**: zero setup for all team members; relational model fits products/customers/orders.
10. **One ERP client** for both deployments (basic auth or OAuth per connector), token caching per connector.
11. **SAP connectors instead of a fixed configuration**: the ERP can be switched at runtime (local ↔ BTP);
    ERP keys are stored per connector because the same product has different UUIDs in each ERP.
    Passwords are never sent to the browser; the BTP secret stays in the key file, not in the database.

## API (excerpt)

`GET /api/products`, `GET /api/products/:id`, `POST|PUT|DELETE /api/products/:id` (admin) ·
`POST /api/auth/register`, `POST /api/auth/login`, `GET|PUT /api/me` ·
`POST /api/orders`, `GET /api/orders`, `PATCH /api/orders/:id/status` (admin), `POST /api/orders/:id/cancel` ·
`GET /api/admin/stats`, `GET /api/admin/customers` · `GET /api/erp/status`, `POST /api/erp/sync`, `POST /api/erp/load-catalog` ·
`GET|POST /api/erp/connectors`, `PUT|DELETE /api/erp/connectors/:id`, `POST /api/erp/connectors/:id/test|activate`,
`POST /api/erp/connectors/test` (unsaved configuration), `POST /api/erp/disconnect` ·
Lab 2: `GET /api/erp/files`, `POST /api/erp/files/mode|export|import|upload`, `GET /api/erp/files/download/:folder/:name` ·
Suppliers: `GET|POST /api/suppliers`, `PUT /api/suppliers/targets` (`{ mode: active|list|all, ids }`), `PUT /api/suppliers/:id`, `POST /api/suppliers/:id/users|preview`, `GET /api/suppliers/deliveries`,
`POST /api/suppliers/process` · Portal (port 3200 or `/portal/`): `POST api/login`, `GET api/me`, `POST api/upload`, `GET api/deliveries`

## Project structure

```
server/src/
  index.js                 Express app, routing, error handling, ERP sync on start
  db.js                    schema, migrations, demo data
  catalog.js               demo catalog (14 products, 4 categories)
  auth.js                  password hashing, sessions, role middleware
  routes/                  products, customers, orders, admin, erp, fileTransfer (Lab 2), suppliers
  services/connectors.js   SAP connectors (list, create, update, delete, active connector)
  services/erpClient.js    Mini-ERP client per connector (REST + OData, basic auth / XSUAA OAuth, retries, timeouts)
  services/erpSync.js      sync of the active connector (start, switch, interval, demo catalog)
  services/serviceKey.js   XSUAA credentials from a key file or a Cloud Foundry service binding
  services/productSync.js  ERP → shop: products and order statuses
  services/erpOrders.js    shop → ERP: orders, customers
  services/erpMasterData.js shop → ERP: product and customer changes, demo catalog
  services/inventory.js    stock handling (local mode)
  services/fileTransfer.js Lab 2: export job, transfer folders, import, log, inbox poller
  services/productFile.js  Lab 2: reads + validates a product file (CSV / XLSX)
  services/xlsxReader.js   Lab 2: minimal .xlsx reader (no dependency)
  services/suppliers.js    suppliers, logins, portal sessions, folders, delivery log, target ERPs (local / cloud / both)
  services/supplierFormats.js  supplier file (CSV/XLSX/JSON/XML) -> canonical products (mapping, values)
  services/supplierImport.js   inbox -> ERP (OData) -> shop, acknowledgements, retries
  services/ftpServer.js    FTP server for supplier systems
  portal/                  supplier portal (separate site): portal.js (API), public/ (page), samples/
scripts/cf-prepare.mjs     creates cf-dist/ + manifest.yml for cf push (npm run cf:build)
client/src/
  pages/                   Shop, Product, Cart, Checkout, Confirmation, Login, Register, Account, Admin
  components/              SapConnectors, FileTransfer, Suppliers (admin tabs), ProductArt, OrderCard, StatusSteps, Modal, Toast, ...
  state.jsx, api.js        auth + cart state, API client
```
