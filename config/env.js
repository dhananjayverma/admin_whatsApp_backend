require('dotenv').config();

module.exports = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT, 10) || 5000,
  API_PREFIX: process.env.API_PREFIX || '/api',

  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp_bulk',

  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  REDIS_HOST: process.env.REDIS_HOST || 'localhost',
  REDIS_PORT: parseInt(process.env.REDIS_PORT, 10) || 6379,
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined,
  /** Set to 0 or false to disable Redis (no connection attempt, no errors). App runs without rate limit/queue/lock. */
  REDIS_ENABLED: process.env.REDIS_ENABLED !== '0' && process.env.REDIS_ENABLED !== 'false',

  JWT_SECRET: process.env.JWT_SECRET || 'your-super-secret-key-min-32-chars-change-in-production',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  REFRESH_TOKEN_EXPIRES_IN: process.env.REFRESH_TOKEN_EXPIRES_IN || '30d',

  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef',

  WHATSAPP_API_BASE_URL: process.env.WHATSAPP_API_BASE_URL || 'https://api.whatsapp.com',
  DEFAULT_PROXY_HOST: process.env.DEFAULT_PROXY_HOST || '',
  DEFAULT_PROXY_PORT: process.env.DEFAULT_PROXY_PORT || '',

  CHUNK_SIZE: parseInt(process.env.CHUNK_SIZE, 10) || 500,
  COOLDOWN_SECONDS: parseInt(process.env.COOLDOWN_SECONDS, 10) || 60,
  COST_PER_MESSAGE: parseFloat(process.env.COST_PER_MESSAGE) || 1,
  /** Max messages per virtual number per day (anti-detection). Reset at midnight. */
  MAX_MESSAGES_PER_NUMBER_PER_DAY: parseInt(process.env.MAX_MESSAGES_PER_NUMBER_PER_DAY, 10) || 500,

  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean) : [],
};
