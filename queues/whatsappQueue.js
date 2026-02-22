const Queue = require('bull');
const Redis = require('ioredis');
const { getRedisOpts, attachRedisErrorHandler } = require('../config/redis');
const { REDIS_URL, REDIS_HOST, REDIS_PORT, REDIS_PASSWORD, REDIS_ENABLED } = require('../config/env');

/** When Redis is disabled, use a no-op queue so no connection is made and no errors appear. */
const stubQueue = {
  add: () => Promise.resolve(),
  process: () => {},
};

if (!REDIS_ENABLED) {
  module.exports = stubQueue;
  return;
}

const redisOpts =
  REDIS_PASSWORD
    ? { host: REDIS_HOST, port: REDIS_PORT, password: REDIS_PASSWORD, maxRetriesPerRequest: null }
    : REDIS_URL && REDIS_URL.startsWith('redis://')
      ? REDIS_URL
      : getRedisOpts();

function createBullRedisClient(type, clientOptions) {
  const opts = clientOptions || (typeof redisOpts === 'string' ? redisOpts : { ...redisOpts });
  const client = typeof opts === 'string' ? new Redis(opts, { maxRetriesPerRequest: null }) : new Redis({ ...opts, maxRetriesPerRequest: null });
  attachRedisErrorHandler(client);
  return client;
}

const whatsappQueue = new Queue('whatsapp-send', {
  redis: redisOpts,
  createClient: createBullRedisClient,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

module.exports = whatsappQueue;
