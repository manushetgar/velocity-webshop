/**
 * Prepares the folder cf-dist/ for `cf push` to SAP BTP (Cloud Foundry):
 * server code + built React app + package.json + manifest.yml. No secrets are copied:
 * in the cloud the shop gets the XSUAA credentials from the service binding (simple-erp-auth-api).
 *
 * Usage: npm run cf:build   (builds the client first), then: cd cf-dist && cf push
 *
 * Role in the architecture: this is a build/deployment helper, not part of the running shop. It packages the
 * shop as ONE Cloud Foundry app: the Express server serves both the API (/api/...) and the built React files
 * (client/dist), so no separate frontend app is needed. In the cloud the shop talks to the Mini-ERP on SAP BTP
 * with OAuth 2.0 client credentials; the XSUAA credentials are injected by Cloud Foundry through the service
 * binding (environment variable VCAP_SERVICES) instead of a service key file.
 * The script is an ES module (.mjs), so it uses `import` and has no __dirname (see `root` below).
 */
// Node.js file system functions (synchronous versions - fine for a one-off build script):
// cpSync = copy files/folders, existsSync = check a path, mkdirSync = create a folder, readFileSync / writeFileSync
// = read / write a file, rmSync = delete a file or folder.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
// Path helpers: dirname = folder part of a path, join = build a path with the correct separator (\ or /).
import { dirname, join } from 'node:path';
// Converts a file:// URL (import.meta.url) into a normal file system path.
import { fileURLToPath } from 'node:url';

// Project root folder: import.meta.url is the URL of THIS file (scripts/cf-prepare.mjs); fileURLToPath + dirname
// give the scripts/ folder, and '..' goes one level up. This makes the script independent of the current
// working directory it is started from.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Output folder that will be pushed to Cloud Foundry (listed in .gitignore, it is generated).
const out = join(root, 'cf-dist');
// Name of the Cloud Foundry application (also used as package name and in the route).
const APP = 'velocity-webshop';
// Name of the XSUAA service instance of the Mini-ERP. The shop app is bound to it, so it receives OAuth client
// credentials that are allowed to call the ERP API.
const XSUAA_SERVICE = 'simple-erp-auth-api';

// The React app must have been built (vite build -> client/dist). Without it the cloud app would have no frontend.
if (!existsSync(join(root, 'client/dist/index.html'))) {
  // Explain how to fix it ...
  console.error('client/dist is missing - run "npm run build" first (or use "npm run cf:build").');
  // ... and stop with exit code 1 (non-zero = failure, so `npm run cf:build` also reports an error).
  process.exit(1);
}

// ERP route: from the environment or from server/.env (ERP_URL of the Mini-ERP on SAP BTP)
// Minimal .env reader (no extra dependency): returns the value of ERP_URL in server/.env, or null.
function erpUrlFromEnvFile() {
  // Path of the shop server's local configuration file.
  const file = join(root, 'server/.env');
  // No .env file -> no value.
  if (!existsSync(file)) return null;
  // Read the file, split it into lines (\r?\n also handles Windows CRLF line endings) and find the first line
  // that starts with "ERP_URL =" (optional spaces before and around the name).
  const line = readFileSync(file, 'utf8').split(/\r?\n/).find(l => /^\s*ERP_URL\s*=/.test(l));
  // Value = everything after the first '=' (split + slice(1) + join('=') keeps any '=' inside the value),
  // trimmed, with one leading and one trailing quote (" or ') removed. null if there is no such line.
  return line ? line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '') : null;
}
// The ERP URL used in the manifest: an environment variable wins over server/.env; '' if neither is set.
// A trailing slash is removed, because the shop appends paths like /rest/api/... to it.
const erpUrl = (process.env.ERP_URL || erpUrlFromEnvFile() || '').replace(/\/$/, '');
// Plausibility check: in the cloud the shop must use the Mini-ERP on SAP BTP, whose Cloud Foundry routes are
// https URLs ending in hana.ondemand.com. This prevents deploying with e.g. http://localhost:4004.
if (!/^https:\/\/.+hana\.ondemand\.com$/.test(erpUrl)) {
  // Error message with an example of the expected URL format.
  console.error('ERP_URL of the Mini-ERP on SAP BTP not found. Set it in server/.env, e.g.\n' +
    '  ERP_URL=https://<org>-<space>-simple-erp-srv.cfapps.us10-001.hana.ondemand.com');
  // Abort the build (exit code 1).
  process.exit(1);
}
// Host name part of the ERP URL (without https:// and path), e.g. <org>-<space>-simple-erp-srv.cfapps....com
const erpHost = new URL(erpUrl).hostname;
// same naming as the ERP route: <org>-<space>-simple-erp-srv -> <org>-<space>-velocity-webshop
// If the ERP host follows that naming, derive the shop's route from it (same org/space prefix and domain);
// otherwise null, and the manifest asks Cloud Foundry for a random route instead.
const shopHost = erpHost.includes('simple-erp-srv') ? erpHost.replace('simple-erp-srv', APP) : null;

// Start from an empty output folder: delete an old cf-dist/ completely (force: no error if it does not exist) ...
rmSync(out, { recursive: true, force: true });
// ... and create it again.
mkdirSync(out, { recursive: true });
// Copy the server code (Express app, routes, services) to cf-dist/server/src - the same relative layout as in
// the project, so index.js finds the React build at ../../client/dist.
cpSync(join(root, 'server/src'), join(out, 'server/src'), { recursive: true });
// Copy the built React app (static HTML/JS/CSS) to cf-dist/client/dist; Express serves it in production.
cpSync(join(root, 'client/dist'), join(out, 'client/dist'), { recursive: true });

// Read the server's package.json to reuse its version and runtime dependencies (express, better-sqlite3, bcryptjs).
const server = JSON.parse(readFileSync(join(root, 'server/package.json'), 'utf8'));
// Write a minimal package.json for the cloud app. The Cloud Foundry Node.js buildpack reads it to install the
// dependencies (npm install in the cloud) and to choose the Node.js version.
writeFileSync(join(out, 'package.json'), JSON.stringify({
  // Package name = app name.
  name: APP,
  // Same version as the shop server.
  version: server.version,
  // private: never published to the npm registry by accident.
  private: true,
  // The code uses ES modules (import/export), like in the project.
  type: 'module',
  // `npm start` (the command in manifest.yml) starts the server. No --env-file here: in the cloud the
  // configuration comes from the env section of manifest.yml (and cf set-env), not from a .env file.
  scripts: { start: 'node server/src/index.js' },
  // Only the server's runtime dependencies (no dev tools such as concurrently or Vite).
  dependencies: server.dependencies,
  // Tells the buildpack to use Node.js 22 (the version the shop is developed for).
  engines: { node: '22.x' },
// JSON.stringify(value, null, 2) = pretty-printed with 2-space indentation; + '\n' = newline at the end of the file.
}, null, 2) + '\n');

// .cfignore works like .gitignore for `cf push`: these files are never uploaded. node_modules/ is installed by
// the buildpack in the Linux container (the local one may contain native binaries for another OS, e.g. the
// better-sqlite3 build for Windows); data/ = a local SQLite database; transfer/ = local Lab 2 transfer files;
// .env and *-key.json can contain secrets (passwords, XSUAA client secrets). Safety net in case such files end up
// in cf-dist/.
writeFileSync(join(out, '.cfignore'), 'node_modules/\ndata/\ntransfer/\n.env\n*-key.json\n');

// Write the Cloud Foundry deployment descriptor manifest.yml (a template literal; ${...} inserts values).
// Content, line by line:
//  - applications / name: one app called velocity-webshop.
//  - memory 256M, disk_quota 512M: resources of the container (enough for a small Node.js app).
//  - instances: 1 - one container. The shop keeps its data in a SQLite file inside its container, so several
//    instances would each have their own, separate database.
//  - buildpacks: nodejs_buildpack - Cloud Foundry installs Node.js and the npm dependencies.
//  - command: npm start - runs the start script of the generated package.json. Cloud Foundry sets the PORT
//    environment variable, which index.js uses to listen on.
//  - routes / random-route (the ${shopHost ? ... : ...} expression): with a derived host name the app gets the
//    route <org>-<space>-velocity-webshop.<domain>; otherwise Cloud Foundry generates a random route.
//  - services: binds the app to the XSUAA instance of the Mini-ERP; Cloud Foundry then puts its credentials
//    (clientid, clientsecret, url) into VCAP_SERVICES - no secret file is needed in the cloud.
//  - env: environment variables of the app:
//      NODE_ENV production   - standard Node.js convention for production (e.g. Express uses production defaults).
//      ERP_URL               - URL of the Mini-ERP on SAP BTP (validated above).
//      ERP_XSUAA_KEY_FILE    - "vcap:<instance>": serviceKey.js reads the credentials from the service binding
//                              (VCAP_SERVICES) instead of a key file.
//      ERP_ACTIVE: btp       - db.js activates the 'btp' SAP connector when it creates the connectors.
//      DEMO_SHOW_ADMIN       - quoted "false" so YAML keeps it a string; hides the admin demo login on the
//                              public login page.
//      ADMIN_PASSWORD        - intentionally only a YAML comment: the password is set with cf set-env, so it is
//                              never written into a file.
writeFileSync(join(out, 'manifest.yml'), `---
# VeloCity web shop on SAP BTP (Cloud Foundry) - generated by scripts/cf-prepare.mjs
applications:
  - name: ${APP}
    memory: 256M
    disk_quota: 512M
    instances: 1
    buildpacks:
      - nodejs_buildpack
    command: npm start
${shopHost ? `    routes:\n      - route: ${shopHost}\n` : '    random-route: true\n'}    services:
      - ${XSUAA_SERVICE}        # XSUAA of the Mini-ERP: OAuth client credentials for the ERP API
    env:
      NODE_ENV: production
      ERP_URL: ${erpUrl}
      ERP_XSUAA_KEY_FILE: vcap:${XSUAA_SERVICE}
      ERP_ACTIVE: btp
      DEMO_SHOW_ADMIN: "false"   # public URL: do not show the admin login on the login page
      PORTAL_PORT: "0"           # one port per app on Cloud Foundry: the supplier portal is served under /portal/
      FTP_PORT: "0"              # Cloud Foundry routes only HTTP - no supplier FTP server in the cloud
      # ADMIN_PASSWORD: set it with  cf set-env ${APP} ADMIN_PASSWORD <password>  (not in this file)
`);

// Summary for the developer: app name, the shop URL (only if a route was derived), the ERP URL with the service
// binding used for authentication, and the next command to deploy (cf push from inside cf-dist/).
console.log(`cf-dist/ is ready.
  App:     ${APP}${shopHost ? `\n  URL:     https://${shopHost}` : ''}
  ERP:     ${erpUrl}  (service binding ${XSUAA_SERVICE})
Next: cd cf-dist && cf push`);
