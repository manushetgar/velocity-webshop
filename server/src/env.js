import { existsSync } from 'node:fs';

const ENV_FILE = '.env';

if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
