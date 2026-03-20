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
      fallbackMessage: doc?.fallbackMessage ?? '',
      rules: Array.isArray(doc?.rules) ? doc.rules : [],
    });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.put('/chatbot', auth, allowRoles('admin', 'client'), async (req, res) => {
  try {
    const { enabled, welcomeMessage, fallbackMessage, rules } = req.body || {};
    const sanitizedRules = Array.isArray(rules)
      ? rules.filter((r) => r.keyword && r.reply).map((r) => ({ keyword: String(r.keyword).slice(0, 100), reply: String(r.reply).slice(0, 500) }))
      : [];
    const doc = await ChatbotConfig.findOneAndUpdate(
      { key: 'default' },
      { $set: { enabled: !!enabled, welcomeMessage: String(welcomeMessage || '').slice(0, 500), fallbackMessage: String(fallbackMessage || '').slice(0, 500), rules: sanitizedRules } },
      { upsert: true, new: true }
    ).lean();
    res.json({ enabled: doc.enabled, welcomeMessage: doc.welcomeMessage, fallbackMessage: doc.fallbackMessage, rules: doc.rules });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
