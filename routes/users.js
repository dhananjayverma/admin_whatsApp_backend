const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { allowRoles } = require('../middleware/rbac');

const router = express.Router();

router.get('/me', (req, res) => {
  res.json({ user: req.user });
});

router.get('/', allowRoles('admin', 'reseller'), async (req, res) => {
  try {
    const { role, resellerId } = req.query;
    const filter = {};
    if (req.user.role === 'reseller') {
      filter.resellerId = req.user._id;
    } else if (role) {
      filter.role = role;
    }
    if (resellerId) filter.resellerId = resellerId;
    const users = await User.find(filter).select('-passwordHash').sort({ createdAt: -1 }).lean();
    res.json({ users });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.put('/:id/sections', allowRoles('admin'), async (req, res) => {
  try {
    const { sections } = req.body;
    const enabledSections = Array.isArray(sections) ? sections : null;
    const updated = await User.findByIdAndUpdate(
      req.params.id,
      { enabledSections },
      { new: true }
    ).select('-passwordHash').lean();
    if (!updated) return res.status(404).json({ message: 'User not found' });
    res.json({ user: updated });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.patch('/:id/toggle-active', allowRoles('admin'), async (req, res) => {
  try {
    const u = await User.findById(req.params.id).select('-passwordHash');
    if (!u) return res.status(404).json({ message: 'User not found' });
    if (u.role === 'admin') return res.status(403).json({ message: 'Cannot deactivate admin' });
    u.isActive = !u.isActive;
    await u.save();
    res.json({ user: u.toObject() });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.patch('/:id', allowRoles('admin'), async (req, res) => {
  try {
    const { password, email } = req.body;
    const update = {};
    if (email) update.email = email.toLowerCase().trim();
    if (password) {
      if (password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });
      update.passwordHash = await bcrypt.hash(password, 10);
    }
    if (!Object.keys(update).length) return res.status(400).json({ message: 'Nothing to update' });
    const updated = await User.findByIdAndUpdate(req.params.id, update, { new: true }).select('-passwordHash').lean();
    if (!updated) return res.status(404).json({ message: 'User not found' });
    res.json({ user: updated });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
