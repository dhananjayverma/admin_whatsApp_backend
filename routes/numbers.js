const express = require('express');
const VirtualNumber = require('../models/VirtualNumber');
const { auth } = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');
const { validateMongoId } = require('../middleware/validate');
const { encrypt } = require('../utils/encryption');

const router = express.Router();

router.get('/', auth, allowRoles('admin'), async (req, res) => {
  try {
    const numbers = await VirtualNumber.find().sort({ createdAt: -1 }).lean();
    numbers.forEach((n) => {
      if (n.vpnPasswordEncrypted) n.vpnPasswordEncrypted = '***';
    });
    res.json({ numbers });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.post('/', auth, allowRoles('admin'), async (req, res) => {
  try {
    const { number, provider, vpnHost, vpnPort, vpnUser, vpnPassword } = req.body || {};
    if (!number) return res.status(400).json({ message: 'number required' });
    const existing = await VirtualNumber.findOne({ number: String(number).trim() });
    if (existing) return res.status(400).json({ message: 'Number already exists' });
    const vpnPasswordEncrypted = vpnPassword ? encrypt(vpnPassword) : '';
    const doc = await VirtualNumber.create({
      number: String(number).trim(),
      provider: provider || '',
      vpnHost: vpnHost || '',
      vpnPort: vpnPort ? parseInt(vpnPort, 10) : null,
      vpnUser: vpnUser || '',
      vpnPasswordEncrypted,
      status: 'active',
    });
    const n = doc.toObject();
    if (n.vpnPasswordEncrypted) n.vpnPasswordEncrypted = '***';
    res.status(201).json({ number: n });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.put('/:id', auth, allowRoles('admin'), validateMongoId('id'), async (req, res) => {
  try {
    const { number, provider, vpnHost, vpnPort, vpnUser, vpnPassword, status } = req.body || {};
    const update = {};
    if (number !== undefined) update.number = String(number).trim();
    if (provider !== undefined) update.provider = provider;
    if (vpnHost !== undefined) update.vpnHost = vpnHost;
    if (vpnPort !== undefined) update.vpnPort = vpnPort ? parseInt(vpnPort, 10) : null;
    if (vpnUser !== undefined) update.vpnUser = vpnUser;
    if (vpnPassword !== undefined && vpnPassword !== '') {
      update.vpnPasswordEncrypted = encrypt(vpnPassword);
    }
    if (status !== undefined) update.status = status;
    const doc = await VirtualNumber.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    if (!doc) return res.status(404).json({ message: 'Virtual number not found' });
    const n = doc.toObject();
    if (n.vpnPasswordEncrypted) n.vpnPasswordEncrypted = '***';
    res.json({ number: n });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
