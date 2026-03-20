const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    console.error(`FATAL: Missing required environment variable: ${name}`);
    console.error(`Set it in backend/.env (see .env.example for a template).`);
    process.exit(1);
  }
  return value;
}

function requiredSecret(name, minLength = 32) {
  const value = required(name);
  if (value.length < minLength) {
    console.error(`FATAL: ${name} must be at least ${minLength} characters.`);
    process.exit(1);
  }
  return value;
}

function requiredInt(name, min, max) {
  const value = required(name);
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) {
    console.error(`FATAL: ${name} must be a number.`);
    process.exit(1);
  }
  if (min != null && n < min) {
    console.error(`FATAL: ${name} must be >= ${min}.`);
    process.exit(1);
  }
  if (max != null && n > max) {
    console.error(`FATAL: ${name} must be <= ${max}.`);
    process.exit(1);
  }
  return n;
}

function requiredFloat(name, min) {
  const value = required(name);
  const n = parseFloat(value);
  if (Number.isNaN(n)) {
    console.error(`FATAL: ${name} must be a number.`);
    process.exit(1);
  }
  if (min != null && n < min) {
    console.error(`FATAL: ${name} must be >= ${min}.`);
    process.exit(1);
  }
  return n;
}

// Optional: present in .env or undefined (no default in code)
function opt(name) {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

// ---------- Required: must be set in .env ----------
const MONGODB_URI = required('MONGODB_URI');
const JWT_SECRET = requiredSecret('JWT_SECRET');
const ENCRYPTION_KEY = requiredSecret('ENCRYPTION_KEY');
const NODE_ENV = required('NODE_ENV');
const PORT = requiredInt('PORT', 1, 65535);
const API_PREFIX = required('API_PREFIX');
const REDIS_URL = required('REDIS_URL');
const REDIS_ENABLED = required('REDIS_ENABLED');
const JWT_EXPIRES_IN = required('JWT_EXPIRES_IN');
const REFRESH_TOKEN_EXPIRES_IN = required('REFRESH_TOKEN_EXPIRES_IN');
const WHATSAPP_API_BASE_URL = opt('WHATSAPP_API_BASE_URL') || '';
const CHUNK_SIZE = requiredInt('CHUNK_SIZE', 1, 100000);
const COOLDOWN_SECONDS = requiredInt('COOLDOWN_SECONDS', 1, 86400);
const COST_PER_MESSAGE = requiredFloat('COST_PER_MESSAGE', 0);
const MAX_MESSAGES_PER_NUMBER_PER_DAY = requiredInt('MAX_MESSAGES_PER_NUMBER_PER_DAY', 1, 100000);

const isProduction = NODE_ENV === 'production';
const REDIS_ENABLED_BOOL = REDIS_ENABLED !== '0' && REDIS_ENABLED !== 'false';

// Optional: no fallback, use only if set in .env
const REDIS_HOST = opt('REDIS_HOST');
const REDIS_PORT = opt('REDIS_PORT') != null ? parseInt(process.env.REDIS_PORT, 10) : undefined;
const REDIS_PASSWORD = opt('REDIS_PASSWORD');
const DEFAULT_PROXY_HOST = opt('DEFAULT_PROXY_HOST');
const DEFAULT_PROXY_PORT = opt('DEFAULT_PROXY_PORT');
const ALLOWED_ORIGINS = opt('ALLOWED_ORIGINS')
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : undefined;

module.exports = {
  NODE_ENV,
  isProduction,
  PORT,
  API_PREFIX,
  MONGODB_URI,
  REDIS_URL,
  REDIS_HOST,
  REDIS_PORT,
  REDIS_PASSWORD,
  REDIS_ENABLED: REDIS_ENABLED_BOOL,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  REFRESH_TOKEN_EXPIRES_IN,
  ENCRYPTION_KEY,
  WHATSAPP_API_BASE_URL,
  DEFAULT_PROXY_HOST: DEFAULT_PROXY_HOST ?? '',
  DEFAULT_PROXY_PORT: DEFAULT_PROXY_PORT ?? '',
  CHUNK_SIZE,
  COOLDOWN_SECONDS,
  COST_PER_MESSAGE,
  MAX_MESSAGES_PER_NUMBER_PER_DAY,
  ALLOWED_ORIGINS: ALLOWED_ORIGINS ?? [],
};
