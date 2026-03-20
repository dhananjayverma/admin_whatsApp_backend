const VirtualNumber = require('../models/VirtualNumber');
const { getRedis } = require('../config/redis');
const { COOLDOWN_SECONDS, MAX_MESSAGES_PER_NUMBER_PER_DAY } = require('../config/env');
const logger = require('../utils/logger');

const COOLDOWN_KEY_PREFIX = 'number:';
const COOLDOWN_SUFFIX = ':cooldown';
// Auto-block a number after this many consecutive failures
const CONSECUTIVE_FAILURE_THRESHOLD = 5;
// Blocked numbers auto-unblock after this many hours (soft reset for retry)
const BLOCK_RESET_HOURS = 6;

/**
 * Auto-unblock numbers that have been blocked for more than BLOCK_RESET_HOURS.
 * Only soft-unblocks numbers blocked by consecutive failures (not hard Meta/operator blocks).
 * Hard blocks (blockReason !== 'consecutive_failures') require manual admin intervention.
 */
async function autoUnblockStaleNumbers() {
  const cutoff = new Date(Date.now() - BLOCK_RESET_HOURS * 60 * 60 * 1000);
  const result = await VirtualNumber.updateMany(
    {
      status: 'blocked',
      blockReason: 'consecutive_failures',
      blockedAt: { $lt: cutoff },
    },
    {
      $set: {
        status: 'active',
        health: 'warning',
        consecutiveFailures: 0,
        blockReason: '',
        blockedAt: null,
      },
    }
  );
  if (result.modifiedCount > 0) {
    logger.info('Auto-unblocked stale numbers', { count: result.modifiedCount, cutoffHours: BLOCK_RESET_HOURS });
  }
  return result.modifiedCount;
}

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

/**
 * Mark a virtual number as blocked (hard block by Meta or operator).
 * The number is set to status 'blocked' and health 'fail'.
 */
async function markBlocked(numberId, reason = 'unknown') {
  await VirtualNumber.updateOne(
    { _id: numberId },
    {
      $set: {
        status: 'blocked',
        health: 'fail',
        blockedAt: new Date(),
        blockReason: reason,
      },
    }
  );
  logger.warn('Virtual number marked as blocked', { numberId, reason });
}

/**
 * Record a send failure on a number. After CONSECUTIVE_FAILURE_THRESHOLD
 * consecutive failures the number is auto-blocked (soft block / warning).
 */
async function recordFailure(numberId) {
  const doc = await VirtualNumber.findByIdAndUpdate(
    numberId,
    { $inc: { consecutiveFailures: 1 } },
    { new: true }
  ).lean();
  if (doc && doc.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD && doc.status === 'active') {
    await VirtualNumber.updateOne(
      { _id: numberId },
      { $set: { status: 'blocked', health: 'warning', blockedAt: new Date(), blockReason: 'consecutive_failures' } }
    );
    logger.warn('Number auto-blocked due to consecutive failures', { numberId, failures: doc.consecutiveFailures });
    return true; // was auto-blocked
  }
  return false;
}

/** Reset consecutive failure counter on a successful send. */
async function recordSuccess(numberId) {
  await VirtualNumber.updateOne(
    { _id: numberId },
    { $set: { consecutiveFailures: 0, health: 'ok' } }
  );
}

/**
 * Check if every active (non-blocked) virtual number is exhausted.
 * Returns true when there are zero numbers available to send.
 */
async function areAllNumbersExhausted() {
  await resetMessagesTodayIfNewDay();
  const count = await VirtualNumber.countDocuments({
    status: 'active',
    $or: [
      { messagesToday: { $lt: MAX_MESSAGES_PER_NUMBER_PER_DAY } },
      { messagesToday: null },
    ],
  });
  if (count === 0) return true;

  // Check whether every candidate is on cooldown
  const candidates = await VirtualNumber.find({
    status: 'active',
    $or: [
      { messagesToday: { $lt: MAX_MESSAGES_PER_NUMBER_PER_DAY } },
      { messagesToday: null },
    ],
  })
    .select('_id')
    .limit(50)
    .lean();

  for (const num of candidates) {
    const onCooldown = await hasCooldown(num._id.toString());
    if (!onCooldown) return false;
  }
  return true;
}

async function getNextNumber() {
  await autoUnblockStaleNumbers();
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

module.exports = {
  getNextNumber,
  setCooldown,
  hasCooldown,
  cooldownKey,
  resetMessagesTodayIfNewDay,
  markBlocked,
  recordFailure,
  recordSuccess,
  areAllNumbersExhausted,
  autoUnblockStaleNumbers,
};
