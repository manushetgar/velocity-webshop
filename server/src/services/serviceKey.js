import { existsSync, readFileSync } from 'node:fs';

const VCAP = 'vcap:';

export function findBinding(instanceName) {
  let services;
  try {
    services = JSON.parse(process.env.VCAP_SERVICES || '{}');
  } catch {
    return null;
  }
  for (const bindings of Object.values(services)) {
    for (const b of bindings) if (b.name === instanceName || b.instance_name === instanceName) return b.credentials;
  }
  return null;
}

export function serviceKeyAvailable(keyFile) {
  if (!keyFile) return false;
  return keyFile.startsWith(VCAP) ? !!findBinding(keyFile.slice(VCAP.length)) : existsSync(keyFile);
}

export function readServiceKey(keyFile) {
  let c;
  if (keyFile?.startsWith(VCAP)) {
    const name = keyFile.slice(VCAP.length);
    c = findBinding(name);
    if (!c) throw new Error(`Service ${name} is not bound to this app (cf bind-service <app> ${name}).`);
  } else {
    if (!keyFile || !existsSync(keyFile))
      throw new Error(`Service key file not found: ${keyFile || '(none)'} (path is relative to the server folder)`);
    try {
      const key = JSON.parse(readFileSync(keyFile, 'utf8'));
      c = key.credentials || key;
    } catch {
      throw new Error(`Service key file ${keyFile} is not valid JSON.`);
    }
  }
  if (!c.url || !c.clientid || !c.clientsecret)
    throw new Error('Service key must contain url, clientid and clientsecret (cf service-key ...).');
  return c;
}
