const { getRedis } = require('../config/redis');

const WINDOW_SEC = 15 * 60; // 15 minutes
const MAX_ATTEMPTS = 10;

/** Rate limit login by IP to prevent brute force. */
async function authRateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const key = `rate:auth:${ip.replace(/[^a-zA-Z0-9.:]/g, '_')}`;
  try {
    const redis = getRedis();
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, WINDOW_SEC);
    if (count > MAX_ATTEMPTS) {
      return res.status(429).json({ message: 'Too many login attempts. Try again later.' });
    }
    next();
  } catch (err) {
    next();
  }
}

module.exports = { authRateLimit };
