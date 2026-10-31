// =====================================================================================================
// serviceKey.js - loads the OAuth 2.0 client credentials (XSUAA) that the shop needs to call the Mini-ERP
// on SAP BTP Cloud Foundry.
//
// Role in the architecture: erpClient.js calls readServiceKey() before it requests an OAuth token, and
// connectors.js calls serviceKeyAvailable() to show "found" / "file missing" in Admin > SAP connectors.
// The credentials (url of the XSUAA token server, clientid, clientsecret) are created on BTP for the XSUAA
// service instance of the ERP (simple-erp-auth-api). They are secrets, so they are never stored in the
// SQLite database: the connector only stores WHERE to find them (column key_file).
// =====================================================================================================

// Import two synchronous file system functions from Node's built-in 'fs' module:
//  - existsSync(path)          -> true/false, does the file exist?
//  - readFileSync(path, enc)   -> the file content as a string (enc 'utf8')
// Synchronous calls are fine here: the file is tiny and only read when a new token is needed.
import { existsSync, readFileSync } from 'node:fs';

/**
 * XSUAA credentials (clientid, clientsecret, url) of an OAuth connector. Two sources:
 *  - "vcap:<service instance>"  service bound to the app on Cloud Foundry (VCAP_SERVICES),
 *                               e.g. vcap:simple-erp-auth-api - no secret file needed in the cloud
 *  - any other value            path of a service key file (output of `cf service-key ...`),
 *                               relative to the server folder, e.g. ./xsuaa-key.json
 */

// Prefix that marks a key_file value as "use the Cloud Foundry service binding" instead of a file path.
const VCAP = 'vcap:';

/** Credentials of a service bound to this app (Cloud Foundry), or null. */
// When an app runs on Cloud Foundry and a service instance is bound to it (cf bind-service or manifest.yml),
// CF injects the environment variable VCAP_SERVICES: a JSON object of the form
//   { "<service type, e.g. xsuaa>": [ { "name": ..., "instance_name": ..., "credentials": { ... } } ] }
// This function searches it for the given service instance and returns its credentials object.
export function findBinding(instanceName) {
  // Will hold the parsed VCAP_SERVICES object.
  let services;
  // Parsing can fail if the variable contains invalid JSON.
  try {
    // Parse VCAP_SERVICES; when not running on Cloud Foundry the variable is missing -> '{}' = no services.
    services = JSON.parse(process.env.VCAP_SERVICES || '{}');
  } catch {
    // Invalid JSON: behave as if no service is bound (the caller then shows a readable error).
    return null;
  }
  // Outer loop: one array of bindings per service type (Object.values ignores the type names).
  for (const bindings of Object.values(services)) {
    // Inner loop: each binding of that type. Match by binding name or by service instance name and return the
    // credentials ({ url, clientid, clientsecret, ... } for XSUAA) of the first match.
    for (const b of bindings) if (b.name === instanceName || b.instance_name === instanceName) return b.credentials;
  }
  // No binding with that name: the service is not bound to this app.
  return null;
}

// Returns true if the credentials of a connector can be found (used by the admin UI: "found" / "file missing").
export function serviceKeyAvailable(keyFile) {
  // Nothing configured -> not available.
  if (!keyFile) return false;
  // "vcap:<name>": available if the service binding exists (!! turns the object/null into true/false);
  // otherwise keyFile is a file path: available if the file exists (path relative to the server folder,
  // i.e. the working directory of the Node process).
  return keyFile.startsWith(VCAP) ? !!findBinding(keyFile.slice(VCAP.length)) : existsSync(keyFile);
}

/** Returns { url, clientid, clientsecret } or throws an Error with a readable message. */
// The error messages tell the admin exactly what to fix (they are shown in the UI via ErpError in erpClient.js).
export function readServiceKey(keyFile) {
  // Will hold the credentials object, whichever source it comes from.
  let c;
  // Source 1: Cloud Foundry service binding ("vcap:<instance>"). ?. protects against keyFile being null.
  if (keyFile?.startsWith(VCAP)) {
    // Cut off the "vcap:" prefix to get the service instance name, e.g. simple-erp-auth-api.
    const name = keyFile.slice(VCAP.length);
    // Look up the credentials of that instance in VCAP_SERVICES.
    c = findBinding(name);
    // Not bound: explain how to fix it (bind the service to the shop app).
    if (!c) throw new Error(`Service ${name} is not bound to this app (cf bind-service <app> ${name}).`);
  // Source 2: a service key JSON file on disk (typical when the shop runs locally and the ERP on BTP).
  } else {
    // No path configured or file does not exist: readable error that also explains how the path is resolved.
    if (!keyFile || !existsSync(keyFile))
      throw new Error(`Service key file not found: ${keyFile || '(none)'} (path is relative to the server folder)`);
    // Reading/parsing can fail if the file is not valid JSON (e.g. extra text copied from the cf CLI output).
    try {
      // Read the file as UTF-8 text and parse it as JSON.
      const key = JSON.parse(readFileSync(keyFile, 'utf8'));
      // Depending on the cf CLI version the credentials are wrapped in { "credentials": { ... } } or are the
      // top-level object itself - support both formats.
      c = key.credentials || key;
    } catch {
      // Replace the low-level JSON syntax error by a message that names the file.
      throw new Error(`Service key file ${keyFile} is not valid JSON.`);
    }
  }
  // Both sources: the three fields needed for the OAuth client credentials flow must be present
  // (url = XSUAA server for the token request, clientid + clientsecret = the shop's identity).
  if (!c.url || !c.clientid || !c.clientsecret)
    throw new Error('Service key must contain url, clientid and clientsecret (cf service-key ...).');
  // Return the credentials object to erpClient.js (oauthToken).
  return c;
}
