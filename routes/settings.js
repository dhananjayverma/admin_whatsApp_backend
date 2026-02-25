const express = require('express');
const { auth } = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');
const { COST_PER_MESSAGE, CHUNK_SIZE, COOLDOWN_SECONDS, MAX_MESSAGES_PER_NUMBER_PER_DAY } = require('../config/env');
const ChatbotConfig = require('../models/ChatbotConfig');

const router = express.Router();

router.get('/', auth, allowRoles('admin'), (req, res) => {
  res.json({
    costPerMessage: COST_PER_MESSAGE,
    chunkSize: CHUNK_SIZE,
    cooldownSeconds: COOLDOWN_SECONDS,
    maxMessagesPerNumberPerDay: MAX_MESSAGES_PER_NUMBER_PER_DAY,
  });
});

router.get('/chatbot', auth, allowRoles('admin', 'reseller', 'client'), async (req, res) => {
  try {
    const doc = await ChatbotConfig.findOne({ key: 'default' }).lean();
    res.json({
      enabled: doc?.enabled ?? false,
      welcomeMessage: doc?.welcomeMessage ?? '',
    });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.put('/chatbot', auth, allowRoles('admin'), async (req, res) => {
  try {
    const { enabled, welcomeMessage } = req.body || {};
    const doc = await ChatbotConfig.findOneAndUpdate(
      { key: 'default' },
      { $set: { enabled: !!enabled, welcomeMessage: String(welcomeMessage || '').slice(0, 500) } },
      { upsert: true, new: true }
    ).lean();
    res.json({ enabled: doc.enabled, welcomeMessage: doc.welcomeMessage });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
