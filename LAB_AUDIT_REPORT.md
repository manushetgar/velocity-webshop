# Lab Audit and Readiness Report

Project: VeloCity Bike Shop (Systems Integration, FH Aachen, winter term 2026/27)
Date: 2026-10-31
Scope: Lab 1 and Lab 2 against the official specs in the course repository
(`lab/simple-web-shop.md`, `lab/file-transfer.md`), the team's Lab 0/Lab 1 guides in `docs/`, and
readiness for Lab 3 (`lab/rpc.md`) and Labs 4/5 (SAP Integration Suite or Apache Karavan).

## 1. How this was verified

| Check | Result |
|---|---|
| `npm run install:ci` (clean `npm ci` from the root lockfile) | OK, 195 packages, native better-sqlite3 loads (SQLite 3.53.2) |
| `npm audit` | 1 high (body-parser 2.0.0-2.3.0, GHSA-27r3-jxmh-p828), fixed in the lockfile, now 0 |
| `npm ls` (root + workspaces) | no missing, invalid or extraneous packages |
| `npm run build` | OK, 63 modules, JS 365 kB (110 kB gzip), CSS 32 kB |
| `node --check` on all server/scripts modules | 31/31 OK |
| Circular imports in `server/src` | none |
| Frontend call vs. backend route cross-check | all 47 calls in `client/src/api.js` and all 8 calls in the supplier portal page map to an existing route with matching method and payload |
| API smoke test, standalone mode (throw-away DB) | 60/60 passed |
| Lab 2 smoke test against a stub Mini-ERP (CSV export/import) | 14/14 passed |
| SPA fallback and portal served by Express from `client/dist` | OK |

Both smoke tests ran against a temporary database and transfer folder; `server/data` was not touched.
Not tested live: the real Mini-ERP (`cds watch`) and SAP BTP, because neither was running on this
machine. The ERP-facing code paths were reviewed by reading them, and the file-transfer path was tested
against a stub that serves the ERP's REST/OData endpoints.

## 2. Lab 1: simple web shop

| Spec requirement | Status | Evidence |
|---|---|---|
| Display list of products | Met | `GET /api/products`, ShopPage, ProductPage |
| Add new / remove products | Met | Admin > Products; `POST/PUT/DELETE /api/products` with validation; soft delete + restore (tested) |
| Product has name, description, price | Met | plus product ID, currency, stock, category |
| Customers register, log in, update personal info | Met | `/api/auth/register`, `/api/auth/login`, `PUT /api/me` incl. password change with current password (tested) |
| Customer has name, e-mail, address, purchase history | Met | `customers` table, `GET /api/orders` (own orders only, others give 404) |
| Create orders by adding products and checking out | Met | cart (localStorage) > checkout > `POST /api/orders`; quantities merged, prices read on the server (tested: client-sent price ignored) |
| Order stores customer, products, quantities, total, status | Met | `orders` + `order_items` with name/price snapshot; status NEW/PICKED/SHIPPED/COMPLETED/CANCELED |

Additional behaviour verified: bcrypt hashes, server-side sessions revoked on logout, 401 vs. 403 for
admin endpoints, oversell rejected with 409, stock released when a NEW order is cancelled, JSON 404 for
unknown API paths, 400 for invalid JSON, generic 500 message with no internals leaked.

## 3. Lab 2: file transfer

| Spec requirement | Status | Evidence |
|---|---|---|
| Web shop file import updates listings (new products, prices, stock) | Met | `services/productFile.js` + `fileTransfer.js`; full-snapshot import in one transaction (tested: price change arrives via file) |
| Export mechanism ERP > shop | Met | export job reads `GET /rest/api/getProducts()` and writes atomically (`.part` + rename) into `inbox/` |
| Naming convention, location, frequency | Met | `products_<source>_<UTC stamp>[-n].csv\|xlsx`; `server/transfer/{inbox,processed,error}`; export every 60 s only on change (SHA-256), poll every 10 s, manual triggers |
| Error handling (invalid format, missing fields, failed transfer) | Met | all-or-nothing; rejected files moved to `error/` with `.error.txt`; duplicate, outdated, future-dated, wrong-source, empty, HTML, missing columns, bad values all rejected; ERP-down export logged once (tested: broken upload rejected, nothing changed, report downloadable) |
| Discussion: pros/cons, consistency | Covered | README "Lab 2"; stock consistency problem in file mode documented |

The supplier extension (portal on :3200, FTP on :2121, CSV/JSON/XML/XLSX mapping, write-to-ERP with
local/cloud/both targets) goes beyond the spec. Login, portal session, demo accounts and the mapping
dry run (`/api/suppliers/:id/preview`) were tested. The FTP server confines each supplier to its own
folder: paths are normalised and only `inbox`/`outbox` etc. are accepted. It also slows down and
disconnects after failed logins.

## 4. Defects found and fixed

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | `body-parser` 2.x DoS advisory (GHSA-27r3-jxmh-p828) via Express 5 | `npm audit fix` (lockfile only) |
| 2 | Medium | Express 5 leaves `req.body` undefined when no JSON body is sent, so `POST /api/orders` or `/api/auth/login` without a body crashed with a 500 | default `req.body` to `{}` in `server/src/index.js` |
| 3 | Medium | Register/profile/login accepted non-string values (name, password, address fields); an object or number reached `.trim()`, bcrypt or SQLite and produced 500s | type checks plus `cleanAddress()` in `routes/customers.js`: strings only, trimmed, max 100 chars, country code normalised to a 2-letter ISO code (the ERP's `country_code`) |
| 4 | Medium | On a public deployment the admin account fell back to the well-known `admin123` if `ADMIN_PASSWORD` was not set; the admin demo login was hidden only by `DEMO_SHOW_ADMIN` | `NODE_ENV=production` without `ADMIN_PASSWORD` now uses a random password and logs a warning; the admin demo login is never listed in production |
| 5 | Low | `.gitignore` missed `.env.*`, `*.sqlite*`, `*.db-shm`, `**/dist`, `.vite`, `Thumbs.db` | rewritten; `.gitattributes` added (LF in the repo, CRLF for `.cmd`) |
| 6 | Low | npm 11 warns that the install scripts of `better-sqlite3` and `esbuild` are not approved; future npm versions will skip them, which would break the native SQLite module | approved in root `package.json` (`allowScripts`) |

## 5. Repository hygiene

- The folder was not a git repository. A local repo was initialised, `.gitignore` fixed first, and the
  untouched project committed as a baseline (`Baseline: project as received`). All changes in this
  audit are staged on top of it and not committed, so they can be reviewed with `git diff --cached`.
  Nothing has been pushed; there is no remote.
- Tracked files: source, config and docs only. No `node_modules`, `.vite`, `dist`, `*.db`, `.env`,
  key files, `esbuild.exe` or `.node` binaries are tracked, so no `git rm --cached` was needed.
- npm: the project uses npm workspaces with one root `package-lock.json` covering `server` and
  `client`. `npm run install:ci` maps to `npm ci`, which installs both deterministically. A separate
  `client/package-lock.json` plus `npm --prefix client ci` was deliberately **not** added: npm
  workspaces do not maintain per-workspace lockfiles, so a second lockfile would drift from the root
  one and install the client's dependencies twice. `dev` and `build` already run both workspaces.

## 6. Refactoring and cleanup applied

- **Comments**: the code had a narration comment above nearly every line (about 6,800 comment lines,
  roughly 45 % of the source, e.g. `// Empty the cart.` above `clear();`). They were removed with a
  parser-based tool (`@babel/parser` for JS/JSX, so strings, regexes and JSX were left intact; each
  file was re-parsed afterwards). JSX `{/* */}` blocks, CSS and HTML comments were removed as well.
  A few one-line comments that explain *why* were kept or re-added: env loading order, the Express 5
  SPA-fallback regex, POSTs not retried (not idempotent), ERP-first checkout, the Mini-ERP
  `cancelOrder` bug. SQL comments inside the schema and `server/.env.example` were kept as
  documentation.
- `start-local.cmd` rewritten without the per-line narration (same behaviour).
- Duplicate `db.js` import in `routes/customers.js` merged.
- `HOW-TO-RUN.txt` and the old README merged into a single `README.md`.
- Engines field raised to `>=22.12` to match the documented minimum.

Note: the Lab 1 guide says "every line of the code has an English comment" and suggests explaining the
code from those comments in the presentation. That is no longer true. The PDF guides themselves
(architecture, data model, design decisions, Q&A) are unchanged and remain the reference.

## 7. Remaining findings (not changed)

| Finding | Impact | Suggestion |
|---|---|---|
| No automated tests or linter in the repo | Regressions in Lab 3+ go unnoticed | Add `node:test` API tests (the two smoke tests from this audit are a starting point) and ESLint |
| No rate limiting on `/api/auth/login` and the portal login | Brute force possible on a public deployment | `express-rate-limit` or a per-IP/user backoff like the FTP server's |
| Expired customer sessions are never deleted (supplier sessions are) | Table grows slowly | Purge on login, as `createPortalSession` does |
| `bcrypt.hashSync` / `compareSync` in request handlers | Blocks the event loop for every login/registration (pure-JS bcrypt, cost 10) | Use the async variants |
| Standalone order status changes are not checked against a state machine (e.g. COMPLETED to NEW) | Only admins; ERP orders are protected by the ERP | Allow-list of transitions in `setStatus` |
| Currency taken from the first cart line | Mixed-currency carts are not rejected | Reject carts with more than one currency |
| ERP order created, local insert fails (known, documented in the Lab 1 guide) | ERP order without a shop record | Reconciliation by `erp_order_id` or an outbox (see Lab 3/5) |
| Relative paths (`./data`, `./transfer`, `.env`) depend on the working directory | Starting `node server/src/index.js` from the root uses other folders | Resolve against the server folder, or always use the npm scripts (documented) |
| Plain FTP | Credentials in clear text | Local demo only (bound to 127.0.0.1, disabled on CF); SFTP/FTPS for real use |
| SQLite on Cloud Foundry is ephemeral | Shop users/orders reset on restart | Documented; HANA HDI container or PostgreSQL for persistence |

## 8. Readiness for the remaining labs

### Structure assessment

| Area | Assessment |
|---|---|
| Layering | Healthy. `routes/` (HTTP, validation) > `services/` (integration, sync) > `db.js`. The browser never sees ERP credentials. No circular imports. |
| Integration seam | Good. All ERP traffic goes through `services/erpClient.js` (`clientFor(conn)`) with timeouts, retries with exponential backoff for reads, no retries for POSTs, and OAuth token caching. Connectors are data (`erp_connectors`) with `auth` (basic/oauth) and `integration` (api/file), so a new integration style can be another value plus another client. |
| Database layer | Adequate for the lab, the weakest part for growth. Raw SQL is spread over 15 modules; schema changes use ad-hoc `ensureColumn` calls with no version table. Local `stock` is referenced in about 75 places. |
| Frontend | Simple and adequate: one API module, two contexts, page-per-route, admin tabs as components. No state library needed at this size. |

### Lab 3: RPC (ERP as single source of truth)

`lab/rpc.md` asks for: no local stock, a real-time stock query when a product is viewed or ordered,
orders created in the ERP via RPC with confirmation/failure feedback, retries, and no stale stock.

- Already met: orders are created in the ERP first (OData `POST /Orders`), the ERP checks stock, 409
  "exceeds stock" is shown to the user, order number returned, status actions in the ERP, timeouts and
  read retries in place.
- Gap: stock is still served from the local SQLite copy (60 s sync plus a sync before checkout), so
  the product page can show stock up to 60 s old.
- Suggested change: in `GET /api/products/:id` (and before checkout) fetch the product's stock live from
  the active ERP (OData `Products?$filter=productID eq '...'&$select=stock`), with an optional very
  short TTL cache. When the ERP is unreachable, return "stock unknown" instead of the local value.
  Then drop `stock` from the local write paths (`inventory.js`, `productSync.js`, file import), keeping
  standalone mode behind a flag if needed. `services/inventory.js` (`getStock`) is already the single
  read point, which keeps this change local.
- For the order POST, consider an idempotency reference (e.g. a shop order UUID stored in the ERP order
  and looked up before a retry) so that failed calls can be retried safely, as the spec asks.

### Labs 4/5: SAP Integration Suite or Apache Karavan, messaging

- Inbound/outbound through a middleware: add a connector type whose client targets the iFlow/Camel
  route endpoints instead of the ERP directly. `clientFor` is the only place that needs a second
  implementation; routes and UI stay the same, as with the existing basic/OAuth switch.
- Messaging: introduce an outbox table (order events written in the same SQLite transaction as the
  order) and a publisher job. That turns the ERP-first checkout into an asynchronous, retryable flow and
  fixes the "ERP order without shop order" gap. The existing pollers (`startBackgroundSync`,
  `startInboxPoller`, `startSupplierPoller`) show the pattern for a consumer loop.
- Before these labs, add versioned migrations (`PRAGMA user_version`) and a small test suite. Both
  labs change the schema and the order flow.

Overall: the codebase is in good shape to extend. No restructuring is needed before Lab 3. The main
work is replacing the local stock copy with live ERP queries and making the order call safely
retryable.
