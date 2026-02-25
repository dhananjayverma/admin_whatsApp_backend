const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { allowRoles } = require('../middleware/rbac');
const { auth } = require('../middleware/auth');
const { authRateLimit } = require('../middleware/authRateLimit');
const { JWT_SECRET, JWT_EXPIRES_IN } = require('../config/env');
const { generateCode, createSvg } = require('../utils/captcha');
const { setCaptcha, getAndDeleteCaptcha, generateCaptchaId } = require('../utils/captchaStore');

const router = express.Router();

router.get('/captcha', async (req, res) => {
  try {
    const id = generateCaptchaId();
    const code = generateCode();
    await setCaptcha(id, code);
    const svg = createSvg(code);
    res.json({ captchaId: id, svg });
  } catch (err) {
    console.error('Captcha error:', err);
    res.status(500).json({ message: 'Failed to generate captcha' });
  }
});

router.post('/login', authRateLimit, async (req, res) => {
  try {
    const { email, password, captchaId, captchaCode } = req.body || {};
    const emailStr = typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : '';
    const passStr = typeof password === 'string' ? password : '';
    const capId = typeof captchaId === 'string' ? captchaId.trim() : '';
    const capCode = typeof captchaCode === 'string' ? captchaCode.trim() : '';

    if (!capId || !capCode) {
      return res.status(400).json({ message: 'Captcha code is required' });
    }
    const storedCode = await getAndDeleteCaptcha(capId);
    if (!storedCode || storedCode !== capCode) {
      return res.status(400).json({ message: 'Invalid or expired captcha. Please refresh and try again.' });
    }

    if (!emailStr || !passStr) {
      return res.status(400).json({ message: 'Email and password required' });
    }
    const user = await User.findOne({ email: emailStr });
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    const match = await bcrypt.compare(passStr, user.passwordHash);
    if (!match) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    const token = jwt.sign(
      { userId: user._id.toString(), role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );
    const u = user.toObject();
    delete u.passwordHash;
    res.json({ token, user: u });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.post('/register', auth, allowRoles('admin', 'reseller'), async (req, res) => {
  try {
    const { email, password, role } = req.body || {};
    const emailStr = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const passStr = typeof password === 'string' ? password : '';
    if (!emailStr || emailStr.length > 254) {
      return res.status(400).json({ message: 'Valid email required' });
    }
    if (!passStr || passStr.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }
    const { resellerId: bodyResellerId } = req.body || {};
    const allowedRole = role === 'reseller' || role === 'client' ? role : 'client';
    if (req.user.role === 'reseller' && allowedRole !== 'client') {
      return res.status(403).json({ message: 'Reseller can only register clients' });
    }
    let resellerId = null;
    if (allowedRole === 'client' && req.user.role === 'reseller') resellerId = req.user._id;
    if (allowedRole === 'client' && req.user.role === 'admin' && bodyResellerId) resellerId = bodyResellerId;
    if (allowedRole === 'reseller' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admin can register resellers' });
    }

    const existing = await User.findOne({ email: emailStr });
    if (existing) return res.status(400).json({ message: 'Email already registered' });

    const passwordHash = await bcrypt.hash(passStr, 12);
    const user = await User.create({
      email: emailStr,
      passwordHash,
      role: allowedRole,
      resellerId,
      creditBalance: 0,
    });
    const u = user.toObject();
    delete u.passwordHash;
    res.status(201).json({ user: u });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.get('/me', auth, async (req, res) => {
  res.json({ user: req.user });
});
// Note: /me is protected by auth middleware above

module.exports = router;
