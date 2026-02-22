const VirtualNumber = require('../models/VirtualNumber');
const { getRedis } = require('../config/redis');
const { COOLDOWN_SECONDS, MAX_MESSAGES_PER_NUMBER_PER_DAY } = require('../config/env');
const logger = require('../utils/logger');

const COOLDOWN_KEY_PREFIX = 'number:';
const COOLDOWN_SUFFIX = ':cooldown';

function cooldownKey(numberId) {
  return `${COOLDOWN_KEY_PREFIX}${numberId}${COOLDOWN_SUFFIX}`;
}

/** Reset messagesToday for numbers where the calendar day has changed. */
async function resetMessagesTodayIfNewDay() {
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  await VirtualNumber.updateMany(
    { $or: [{ messagesTodayResetAt: { $lt: startOfToday } }, { messagesTodayResetAt: null }] },
    { $set: { messagesToday: 0, messagesTodayResetAt: new Date() } }
  );
}

async function setCooldown(numberId) {
  const redis = getRedis();
  const key = cooldownKey(numberId);
  await redis.set(key, '1', 'EX', COOLDOWN_SECONDS);
  logger.debug('Cooldown set', { numberId, seconds: COOLDOWN_SECONDS });
}

async function hasCooldown(numberId) {
  const redis = getRedis();
  const key = cooldownKey(numberId);
  const v = await redis.get(key);
  return !!v;
}

async function getNextNumber() {
  await resetMessagesTodayIfNewDay();

  const numbers = await VirtualNumber.find({
    status: 'active',
    $or: [
      { messagesToday: { $lt: MAX_MESSAGES_PER_NUMBER_PER_DAY } },
      { messagesToday: null },
    ],
  })
    .sort({ lastUsedAt: 1 })
    .limit(50)
    .lean();

  for (const num of numbers) {
    const onCooldown = await hasCooldown(num._id.toString());
    if (!onCooldown) {
      await VirtualNumber.updateOne(
        { _id: num._id },
        { $set: { lastUsedAt: new Date() }, $inc: { messagesToday: 1 } }
      );
      return num;
    }
  }
  return null;
}

module.exports = { getNextNumber, setCooldown, hasCooldown, cooldownKey, resetMessagesTodayIfNewDay };
