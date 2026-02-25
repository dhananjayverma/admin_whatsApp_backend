const express = require('express');
const User = require('../models/User');
const { auth } = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');

const router = express.Router();

router.get('/me', auth, (req, res) => {
  res.json({ user: req.user });
});

router.get('/', auth, allowRoles('admin', 'reseller'), async (req, res) => {
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

module.exports = router;
