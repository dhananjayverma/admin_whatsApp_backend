const Redis = require('ioredis');
const { REDIS_URL, REDIS_HOST, REDIS_PORT, REDIS_PASSWORD, REDIS_ENABLED } = require('./env');

function getRedisOpts() {
  if (REDIS_URL && REDIS_URL.startsWith('redis://')) {
    return {
      maxRetriesPerRequest: null,
      ...(REDIS_PASSWORD && { password: REDIS_PASSWORD }),
    };
  }
  return {
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
  };
}

let redisUnavailable = false;

/** No-op Redis stub when Redis is disabled or down. App runs without rate limit/queue/lock. */
function createRedisStub() {
  const noop = () => Promise.resolve();
  const noopStr = () => Promise.resolve(null);
  return {
    get: noopStr,
    set: noop,
    del: noop,
    expire: noop,
    incr: () => Promise.resolve(1),
    quit: noop,
  };
}

let redisStub = null;

function attachRedisErrorHandler(client) {
  client.on('error', () => {
    redisUnavailable = true;
  });
  return client;
}

let redisClient = null;

function getRedis() {
  if (!REDIS_ENABLED) {
    if (!redisStub) redisStub = createRedisStub();
    return redisStub;
  }
  if (redisUnavailable) {
    if (!redisStub) redisStub = createRedisStub();
    return redisStub;
  }
  if (!redisClient) {
    if (REDIS_URL && REDIS_URL.startsWith('redis://')) {
      redisClient = new Redis(REDIS_URL, getRedisOpts());
    } else {
      redisClient = new Redis(getRedisOpts());
    }
    attachRedisErrorHandler(redisClient);
  }
  return redisClient;
}

module.exports = { getRedis, getRedisOpts, attachRedisErrorHandler };
