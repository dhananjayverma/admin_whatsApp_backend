const crypto = require('crypto');
const { getRedis } = require('../config/redis');
const { REDIS_ENABLED } = require('../config/env');

const CAPTCHA_PREFIX = 'captcha:';
const CAPTCHA_TTL_SEC = 300; // 5 min

const memoryStore = new Map();
const MEMORY_TTL_MS = CAPTCHA_TTL_SEC * 1000;

async function setCaptcha(id, code) {
  if (REDIS_ENABLED) {
    try {
      const redis = getRedis();
      await redis.set(CAPTCHA_PREFIX + id, code, 'EX', CAPTCHA_TTL_SEC);
      return;
    } catch (_) {
      /* fall through to memory */
    }
  }
  memoryStore.set(id, { code, expires: Date.now() + MEMORY_TTL_MS });
}

async function getAndDeleteCaptcha(id) {
  if (REDIS_ENABLED) {
    try {
      const redis = getRedis();
      const key = CAPTCHA_PREFIX + id;
      const code = await redis.get(key);
      await redis.del(key);
      if (code) return code;
    } catch (_) {
      /* fall through to memory */
    }
  }
  const entry = memoryStore.get(id);
  memoryStore.delete(id);
  if (!entry || Date.now() > entry.expires) return null;
  return entry.code;
}

function generateCaptchaId() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = { setCaptcha, getAndDeleteCaptcha, generateCaptchaId };
