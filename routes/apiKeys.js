const express = require('express');
const crypto = require('crypto');
const ApiKey = require('../models/ApiKey');
const User = require('../models/User');
const { auth } = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');

const router = express.Router();

const MAX_KEYS_PER_USER = 10;

function generateKey() {
  return 'wab_' + crypto.randomBytes(32).toString('hex');
}

// Create a new API key (client / reseller / admin)
router.post('/', auth, allowRoles('admin', 'reseller', 'client'), async (req, res) => {
  try {
    const { name = 'My API Key' } = req.body || {};
    const trimmedName = String(name).trim().slice(0, 100) || 'My API Key';

    const existing = await ApiKey.countDocuments({ userId: req.user._id, active: true });
    if (existing >= MAX_KEYS_PER_USER) {
      return res.status(400).json({ message: `Maximum ${MAX_KEYS_PER_USER} active API keys allowed.` });
    }

    const rawKey = generateKey();
    const keyPrefix = rawKey.slice(0, 12) + '…';

    const apiKey = await ApiKey.create({
      userId: req.user._id,
      name: trimmedName,
      key: rawKey,
      keyPrefix,
    });

    // Return the full key ONCE — never returned again
    res.status(201).json({ apiKey: { ...apiKey.toObject(), key: rawKey }, rawKey });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// List own API keys (key field omitted)
router.get('/', auth, allowRoles('admin', 'reseller', 'client'), async (req, res) => {
  try {
    const keys = await ApiKey.find({ userId: req.user._id })
      .select('-key')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ keys });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// Revoke (delete) own key
router.delete('/:id', auth, allowRoles('admin', 'reseller', 'client'), async (req, res) => {
  try {
    const key = await ApiKey.findOne({ _id: req.params.id, userId: req.user._id });
    if (!key) return res.status(404).json({ message: 'API key not found' });
    await ApiKey.deleteOne({ _id: key._id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// Admin: list all API keys across all users
router.get('/all', auth, allowRoles('admin'), async (req, res) => {
  try {
    const keys = await ApiKey.find()
      .select('-key')
      .sort({ createdAt: -1 })
      .limit(500)
      .populate('userId', 'email role')
      .lean();
    res.json({ keys });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// Admin: revoke any key
router.delete('/admin/:id', auth, allowRoles('admin'), async (req, res) => {
  try {
    const result = await ApiKey.deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ message: 'API key not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
