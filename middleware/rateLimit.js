const { getRedis } = require('../config/redis');

const WINDOW_SEC = 60;
const MAX_REQUESTS = 100;

async function rateLimit(req, res, next) {
  if (!req.user) return next();
  const redis = getRedis();
  const key = `rate:${req.user._id}:api`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, WINDOW_SEC);
    if (count > MAX_REQUESTS) {
      return res.status(429).json({ message: 'Too many requests' });
    }
    next();
  } catch (err) {
    next();
  }
}

module.exports = { rateLimit };
