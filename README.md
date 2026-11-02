# VeloCity Bike Shop

A demo bike shop with customer accounts, a shopping cart, orders, and an admin area.
It can run on its own or connect to a separate SAP Mini-ERP for product and order data.
It also demonstrates exchanging product files and accepting supplier deliveries.

**Start here:** [Run locally](#run-locally) |
[Try the shop](#try-the-shop) |
[How integration works](#how-integration-works) |
[Troubleshooting](#troubleshooting)

## What is in this repo?

- **Shop:** browse and search products, register or log in, update your address, check out, and view orders.
- **Admin area:** manage products and orders, choose an ERP connection, import product files, and manage suppliers.
- **Supplier portal and FTP server:** receive supplier files and send their product changes to the ERP.

The shop uses **React + Vite** in the browser, **Express on Node.js** for its API,
and **SQLite** for local storage. The Mini-ERP is a separate application, not included here.

```text
Browser shop --> Shop API --> SQLite
                    |
                    +--> Mini-ERP API (when connected)

File mode:  Mini-ERP --> Shop's export job --> Product file --> Shop import --> SQLite
Suppliers:  Portal / FTP --> Map and validate file --> Mini-ERP --> Shop sync
```

The browser calls the shop API, not the ERP directly. ERP credentials are used by the server.

## Run locally

### 1. Install the shop

You need **Node.js 22.12 or newer** and npm. Run these commands from the root of your
local checkout (the folder containing this README):

```text
node --version
npm ci
```

This installs both the client and server using the root lockfile. Run dependency
installation commands here, rather than separately inside the workspaces.

On Windows, use `npm.cmd` and `npx.cmd` if PowerShell blocks `npm.ps1` or `npx.ps1`.
SQLite uses the native `better-sqlite3` package; see [Troubleshooting](#troubleshooting)
if installation fails.

### 2. Choose whether to use the ERP

**To explore just the shop (no ERP required):**

Before the first start, copy [server/.env.example](server/.env.example) to `server/.env`.
For example, in PowerShell:

```powershell
Copy-Item server\.env.example server\.env
```

Add this line to the copied file:

```dotenv
ERP_ACTIVE=none
```

This starts the shop with its sample products and local stock. If you have already
started it before, log in as admin and use **Admin > SAP connectors > Disconnect**
instead: the active connector is saved in the database, not reselected from the
environment on every start.

**To use the local Mini-ERP:**

The default connection expects an ERP at <http://localhost:4004>. In a separate
folder, install and start it:

```text
git clone https://codeberg.org/ceedee666/systems-integration.git
```

Then open `systems-integration`, enter its `src` folder and then `simple-erp`, and run:

```text
npm install
npx cds watch
```

Keep that terminal open. The shop's default ERP credentials are
`service-user` / `service-user`. To open the ERP's browser apps, use `alice` / `alice`.
The default local connector also creates missing demo-catalog products in the ERP
and fills missing descriptions.

No shop configuration file is needed for this default setup. If you previously
selected standalone mode, activate **Local SAP (cds watch)** with **Use this ERP**
in **Admin > SAP connectors**.

### 3. Start the shop

In another terminal, at this repo's root:

```text
npm run dev
```

| What | Default address |
|---|---|
| Web shop | <http://localhost:5173> |
| Shop API health check | <http://localhost:3001/api/health> |
| Supplier portal | <http://localhost:3200> |
| Portal through the backend | <http://localhost:3001/portal/> |
| Supplier FTP | `127.0.0.1`, port `2121` |

`npm run dev` starts the API and Vite together. Stop them with **Ctrl+C**.
The API health check confirms the shop server is responding; it does not check ERP connectivity.

**Windows shortcut:** after installing both applications, [start-local.cmd](start-local.cmd)
starts the ERP and shop in separate windows. It expects the ERP at
`%USERPROFILE%\systems-integration\src\simple-erp`; edit `ERP_DIR` in the script if needed.
It uses your existing shop settings, so it does not reactivate a disconnected connector.

## Try the shop

These are the default accounts created when the database is first initialized:

| Role | Email or username | Password |
|---|---|---|
| Shop admin | `admin@webshop.local` | `admin123` |
| Customer | `customer@webshop.local` | `customer123` |
| Suppliers (portal / FTP) | `bikeparts`, `globalcycle`, `nordicgear`, `celticparts` | `supplier123` |

1. Log in as the customer, add an in-stock product to the cart, and check out.
   An address is required; the demo customer already has one.
2. Open **My orders** to see the order. Checkout is a demo, not an online payment integration.
3. Log in as admin and open **Admin** to manage products, orders, and integrations.

Use these accounts only for local demonstrations. `DEMO_MODE=false` hides the shop's
demo-login shortcuts; it does **not** disable or delete the accounts.

## How integration works

An **ERP connector** stores the URL, credentials, and integration mode for one ERP.
Manage connectors in **Admin > SAP connectors**; only one is active at a time.

| Mode | Product data | Checkout |
|---|---|---|
| Standalone (disconnected) | Stored and managed in the shop's SQLite database. | Creates a local order and reduces local stock. |
| API (default for a connector) | Copied from the active ERP on sync. Product creation and supported edits write to the ERP first. | By default, creates the ERP order first, then saves a local copy. ERP rejection prevents the local order. |
| File transfer | Imported from CSV or XLSX snapshots. Change ERP-owned product details in the ERP, not in the shop. | Creates a local order only. A later snapshot can overwrite the locally reduced stock. |

API synchronization runs at startup and every **60 seconds** by default. It also
runs after relevant changes, or when you press **Sync now**. This is not a continuous
live connection. `ERP_ORDERS=false` can disable ERP checkout in API mode.

Removing a product in the shop is a local soft delete, not a deletion from the ERP.

### Product files: ERP to shop

Open **Admin > File transfer** and select **File transfer** for the active connector.

1. The **shop server's export job** calls the ERP's CSV export endpoint
   (`/rest/api/getProducts()`). This still needs a reachable ERP API.
2. It writes a file to `server/transfer/inbox`. Scheduled exports check every
   60 seconds by default and write a new file only when the exported content changes.
3. The shop imports the file into SQLite, then moves it to `processed`.
   Rejected files go to `error`, with an error report and an entry in **History**.

The inbox is also polled every **10 seconds** by default. Use **Export from ERP now**
and **Import inbox now** to run the steps manually, or **Upload file** to import an
ERP CSV or an XLSX spreadsheet export without running the export job.

Important details:

- Inbox filenames follow `products_<source>_<YYYYMMDDTHHMMSSZ>[-n].csv` (or `.xlsx`).
  `source` is the connector ID; browser uploads receive a generated `upload` filename.
  The timestamp is UTC and the numeric suffix is optional.
- Each file is a **full product snapshot**, not a list of changes. Products missing
  from it are unlinked from that connector and disappear from its shop listing.
- Validation errors reject the whole file before product data is changed.
  Examples include missing required columns, invalid prices or stock, duplicate
  product IDs, and invalid or outdated filenames.
- If an export fails, the shop keeps its last imported data.
- File-mode orders are **not sent back to the ERP**. Stock can therefore become
  inconsistent between file imports.

To try it: change a price in the ERP, export and import, then reload the shop.

### Supplier files: supplier to ERP

This is a separate flow from the ERP snapshot import above. Suppliers upload their
own **CSV, JSON, XML, or XLSX** files through the portal or plain FTP. The shop maps
and validates them, writes allowed product changes to the selected ERP target(s),
then syncs the shop from its active ERP.

- Set formats, field mappings, permitted updates, and ERP targets in **Admin > Suppliers**.
- For FTP, use a supplier account, upload into `/inbox`, and read acknowledgements
  in `/outbox`. This is unencrypted FTP, intended for a local demo.
- Deliveries waiting for an unavailable ERP are retried automatically.
- Try the [sample files](server/src/portal/samples/), including an intentionally broken CSV.

## Configuration and saved data

[server/.env.example](server/.env.example) lists the available settings and defaults.
Copy it to `server/.env` only if you need changes, then restart the server.
With the provided npm scripts, relative server paths are resolved from `server`.

| Setting | Default / purpose |
|---|---|
| `PORT` | `3001`, shop API port |
| `DB_FILE` | `./data/webshop.db`, SQLite file |
| `ERP_ACTIVE` | `local` on a fresh local setup; `none` starts disconnected |
| `ERP_SYNC_INTERVAL_S` | `60`; `0` disables the periodic sync/export timer |
| `FILE_POLL_INTERVAL_S` | `10`; `0` disables the inbox polling timer |
| `PORTAL_PORT` | `3200`; `0` leaves the portal available only under the backend's `/portal/` |
| `FTP_PORT` | `2121`; `0` disables FTP |

Connector environment settings populate an empty connector list. Afterwards, edit
connections in the admin UI. Seed-account settings do not update existing passwords.
Changing `PORT` also requires updating the API proxy in [client/vite.config.js](client/vite.config.js)
when using the Vite development server.

SQLite keeps shop accounts, sessions, orders, products, and integration settings across
local restarts. In contrast, the default local Mini-ERP uses an **in-memory database**:
restarting it resets its data, including ERP orders and supplier-created products.

**Reset warning:** stop the shop before running `npm run reset-db`. It deletes
`server/data`, including the default shop database; it does not reset a custom
`DB_FILE`, the ERP, browser cart data, or transfer folders.

Keep credentials private. Environment files, service keys, the local database, and
runtime transfer folders are ignored by Git.

## Useful commands

Run these at the repository root:

| Command | Purpose |
|---|---|
| `npm ci` | Install both workspaces from the lockfile (`npm run install:ci` is an alias). |
| `npm run dev` | Start the API and Vite development server. |
| `npm run build` | Build the frontend into `client/dist`. |
| `npm start` | Start only the backend; also serves the built frontend, if present, at <http://localhost:3001>. |
| `npm run reset-db` | Delete the default shop data directory (see warning above). |
| `npm run cf:build` | Build the frontend and generate a Cloud Foundry deployment folder, `cf-dist`. |

## Optional: SAP BTP

For a **local shop connected to an ERP already deployed on SAP BTP**, save the ERP's
XSUAA service-key JSON as `server/xsuaa-key.json`. Add a connector using the
**SAP BTP (Cloud Foundry)** template, enter the ERP URL and `./xsuaa-key.json`,
test it, then choose **Use this ERP**.

For **deploying the shop itself**, the packaging script requires a BTP `ERP_URL`
in the environment or `server/.env`. The generated manifest expects an existing
`simple-erp-auth-api` service in the target Cloud Foundry space.

```text
npm run cf:build
```

Enter the generated `cf-dist` folder, then:

```text
cf push --no-start
cf set-env velocity-webshop ADMIN_PASSWORD "replace-with-a-strong-password"
cf start velocity-webshop
```

Set the password **before the first start**: changing the environment later does not
change an existing admin account. The generated deployment uses the bound XSUAA
service for ERP access, serves the portal under `/portal/`, and disables FTP.
Its SQLite database and transfer files are on ephemeral container storage, not a
durable cloud database. Do not rely on them surviving restaging or instance replacement.
This is a demo deployment, not a production-ready shop.

## Troubleshooting

| Problem | What to check |
|---|---|
| `npm.ps1 cannot be loaded` | Use `npm.cmd` (and `npx.cmd`) on Windows. |
| `npm ci` fails with `EPERM` | Stop this project's running development servers and retry; files may be locked. |
| `better-sqlite3` fails to install | Try a supported Node LTS release, such as 22 or 24. If no prebuilt binary is available, a source build needs Python and a C++ toolchain (Visual Studio Build Tools on Windows). |
| Empty catalog or ERP unavailable | Start the ERP and check the active connector's URL and credentials, then use **Sync now**. To work without an ERP, use **Disconnect**. |
| A port is already in use | Stop the conflicting instance or change its port. See the `PORT` proxy note above; Vite's port is configured separately. |
| A product file is rejected | Read **Admin > File transfer > History** and its error report. Check format, required fields, source, and timestamp. |
| ERP data disappeared after restart | The default local ERP stores data in memory. The shop's SQLite database is separate. |

## Where to look in the code

| Location | Responsibility |
|---|---|
| [client/src/pages](client/src/pages/) | Shop, account, checkout, and admin screens |
| [client/src/components](client/src/components/) | Shared UI and integration-management screens |
| [client/src/api.js](client/src/api.js), [client/src/state.jsx](client/src/state.jsx) | Browser API calls, authentication state, and cart state |
| [server/src/index.js](server/src/index.js) | Starts the API, portal, FTP, and background jobs |
| [server/src/db.js](server/src/db.js) | SQLite schema, migrations, sample data, and initial accounts |
| [server/src/routes](server/src/routes/) | HTTP endpoints for shop and admin actions |
| [server/src/services](server/src/services/) | ERP clients, sync, inventory, file parsing, and supplier processing |
| [server/src/portal](server/src/portal/) | Supplier portal and sample deliveries |
| [scripts/cf-prepare.mjs](scripts/cf-prepare.mjs) | Cloud Foundry packaging |

Older setup and design walkthroughs are available in [docs](docs/); use the current
code and the configuration template as the reference for runtime behavior.
