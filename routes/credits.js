const express = require('express');
const creditService = require('../services/creditService');
const User = require('../models/User');
const { auth } = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');
const { validateCreditPurchase } = require('../middleware/validate');

const router = express.Router();

router.post('/purchase', auth, allowRoles('admin', 'reseller'), validateCreditPurchase, async (req, res) => {
  try {
    const { userId: targetUserId, amount } = req.body || {};
    const amountNum = parseInt(amount, 10);
    const target = await User.findById(targetUserId);
    if (!target) return res.status(404).json({ message: 'User not found' });
    if (req.user.role === 'reseller') {
      if (target.resellerId?.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: 'Can only grant credits to your clients' });
      }
    }
    const balanceAfter = await creditService.add(
      targetUserId,
      amountNum,
      'grant',
      { grantedBy: req.user._id }
    );
    res.json({ balanceAfter, userId: targetUserId });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.get('/history', auth, async (req, res) => {
  try {
    const userId = req.query.userId || req.user._id.toString();
    if (req.user.role === 'client' && userId !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (req.user.role === 'reseller') {
      const target = await User.findOne({ _id: userId, resellerId: req.user._id });
      if (!target && userId !== req.user._id.toString()) {
        return res.status(403).json({ message: 'Forbidden' });
      }
    }
    const { list, total } = await creditService.getHistory(userId, {
      limit: parseInt(req.query.limit, 10) || 50,
      skip: parseInt(req.query.skip, 10) || 0,
    });
    res.json({ list, total });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
