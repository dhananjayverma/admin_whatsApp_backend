const User = require('../models/User');
const CreditTransaction = require('../models/CreditTransaction');
const logger = require('../utils/logger');

async function deduct(userId, amount, campaignId, meta = {}) {
  const result = await User.findOneAndUpdate(
    { _id: userId, creditBalance: { $gte: amount } },
    { $inc: { creditBalance: -amount } },
    { new: true }
  );
  if (!result) {
    const err = new Error('Insufficient credits');
    err.code = 'INSUFFICIENT_CREDITS';
    throw err;
  }
  await CreditTransaction.create({
    userId,
    type: 'deduction',
    amount: -amount,
    balanceAfter: result.creditBalance,
    campaignId,
    meta,
  });
  logger.debug('Credit deducted', { userId, amount, balanceAfter: result.creditBalance });
  return result.creditBalance;
}

async function add(userId, amount, type = 'grant', meta = {}) {
  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { creditBalance: amount } },
    { new: true }
  );
  if (!user) throw new Error('User not found');
  await CreditTransaction.create({
    userId,
    type,
    amount,
    balanceAfter: user.creditBalance,
    meta,
  });
  logger.debug('Credits added', { userId, amount, type, balanceAfter: user.creditBalance });
  return user.creditBalance;
}

async function getHistory(userId, options = {}) {
  const { limit = 50, skip = 0 } = options;
  const list = await CreditTransaction.find({ userId })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
  const total = await CreditTransaction.countDocuments({ userId });
  return { list, total };
}

async function getHistoryAll(options = {}) {
  const { limit = 50, skip = 0 } = options;
  const list = await CreditTransaction.find({})
    .populate('userId', 'email role')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
  const total = await CreditTransaction.countDocuments({});
  return { list, total };
}

module.exports = { deduct, add, getHistory, getHistoryAll };
