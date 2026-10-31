// ---------------------------------------------------------------------------------------------------------------
// env.js - loads the optional configuration file server/.env into process.env.
//
// Why a module instead of the Node flag `--env-file-if-exists=.env`?
// In watch mode (`node --watch`, used by `npm run dev`) Node 22 also tries to watch the .env file and crashes with
// "ENOENT ... watch '.env'" when the file does not exist - which is the normal case for a fresh copy of the project,
// because .env is never shared (it can contain secrets). Loading the file here works with and without .env.
//
// index.js imports this module FIRST. ES modules are evaluated in import order, so the variables are set before
// db.js and the other modules read process.env (e.g. PORT, DB_FILE, ERP_URL).
// ---------------------------------------------------------------------------------------------------------------

// existsSync: synchronous check whether a file exists.
import { existsSync } from 'node:fs';

// Path of the file, relative to the working directory: `npm run dev` / `npm start` run in the server folder, so this
// is server/.env. On SAP BTP Cloud Foundry there is no .env file; the configuration comes from manifest.yml instead.
const ENV_FILE = '.env';

// Load the file only if it exists. process.loadEnvFile (built into Node 20.12+) reads KEY=value lines and puts them
// into process.env; variables that are already set in the environment are NOT overwritten.
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
