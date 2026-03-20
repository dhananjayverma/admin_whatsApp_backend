const express = require('express');
const Campaign = require('../models/Campaign');
const Recipient = require('../models/Recipient');
const campaignService = require('../services/campaignService');
const { validateNumbers } = require('../utils/validateNumbers');
const { auth } = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');
const { validateCampaignBody, validateMongoId } = require('../middleware/validate');

const router = express.Router();

router.post('/validate-numbers', auth, allowRoles('admin', 'reseller', 'client'), (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : req.body?.numbers || req.body?.recipients || [];
    const result = validateNumbers(rows);
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

const canAccessCampaign = (campaign, user) => {
  if (user.role === 'admin') return true;
  if (campaign.userId.toString() === user._id.toString()) return true;
  if (user.role === 'reseller') {
    const client = campaign.userId;
    return client && client.resellerId?.toString() === user._id.toString();
  }
  return false;
};

router.post('/', auth, allowRoles('admin', 'reseller', 'client'), validateCampaignBody, async (req, res) => {
  try {
    const { name, messageBody, type, buttonQuestion, buttonOptions, delayMs, delayMin, delayMax } = req.body || {};
    const campaign = await campaignService.create(req.user._id, name, messageBody, {
      type,
      buttonQuestion,
      buttonOptions,
      delayMs: typeof delayMs === 'number' ? delayMs : undefined,
      delayMin: typeof delayMin === 'number' ? delayMin : undefined,
      delayMax: typeof delayMax === 'number' ? delayMax : undefined,
    });
    res.status(201).json({ campaign });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.get('/', auth, allowRoles('admin', 'reseller', 'client'), async (req, res) => {
  try {
    const filter = {};
    if (req.user.role === 'client') filter.userId = req.user._id;
    if (req.user.role === 'reseller') {
      const User = require('../models/User');
      const clientIds = await User.find({ resellerId: req.user._id }).distinct('_id');
      filter.userId = { $in: clientIds };
    }
    const campaigns = await Campaign.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ campaigns });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.get('/:id', auth, allowRoles('admin', 'reseller', 'client'), validateMongoId('id'), async (req, res) => {
  try {
    const { getCampaignWithAccess } = require('../services/campaignService');
    const { campaign } = await getCampaignWithAccess(req.params.id, req.user);
    res.json({ campaign });
  } catch (err) {
    if (err.message === 'Campaign not found') return res.status(404).json({ message: err.message });
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.put('/:id', auth, allowRoles('admin', 'reseller', 'client'), validateMongoId('id'), validateCampaignBody, async (req, res) => {
  try {
    const { name, messageBody, type, buttonQuestion, buttonOptions, delayMin, delayMax } = req.body || {};
    const campaign = await campaignService.update(req.params.id, req.user, {
      name,
      messageBody,
      type,
      buttonQuestion,
      buttonOptions,
      delayMin: typeof delayMin === 'number' ? delayMin : undefined,
      delayMax: typeof delayMax === 'number' ? delayMax : undefined,
    });
    res.json({ campaign });
  } catch (err) {
    if (err.message === 'Campaign not found') return res.status(404).json({ message: err.message });
    if (err.message === 'Only draft campaigns can be updated') return res.status(400).json({ message: err.message });
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.post('/:id/recipients', auth, allowRoles('admin', 'reseller', 'client'), validateMongoId('id'), async (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : req.body.recipients || [];
    const result = await campaignService.addRecipients(req.params.id, req.user, rows);
    res.json(result);
  } catch (err) {
    if (err.message === 'Campaign not found') return res.status(404).json({ message: err.message });
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.post('/:id/start', auth, allowRoles('admin', 'reseller', 'client'), validateMongoId('id'), async (req, res) => {
  try {
    const result = await campaignService.start(req.params.id, req.user);
    res.json(result);
  } catch (err) {
    if (err.code === 'INSUFFICIENT_CREDITS') return res.status(400).json({ message: err.message });
    if (err.message === 'Campaign not found') return res.status(404).json({ message: err.message });
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.post('/:id/pause', auth, allowRoles('admin', 'reseller', 'client'), validateMongoId('id'), async (req, res) => {
  try {
    const result = await campaignService.pause(req.params.id, req.user);
    res.json(result);
  } catch (err) {
    if (err.message === 'Campaign not found') return res.status(404).json({ message: err.message });
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.get('/:id/export', auth, allowRoles('admin', 'reseller', 'client'), validateMongoId('id'), async (req, res) => {
  try {
    const { getCampaignWithAccess } = require('../services/campaignService');
    await getCampaignWithAccess(req.params.id, req.user);
    const recipients = await Recipient.find({ campaignId: req.params.id })
      .select('phone name status sentAt failureReason')
      .sort({ createdAt: 1 })
      .lean();
    const format = (req.query.format || 'csv').toLowerCase();
    if (format === 'csv') {
      const header = 'phone,name,status,sentAt,failureReason\n';
      const rows = recipients.map((r) => {
        const phone = String(r.phone || '').replace(/"/g, '""');
        const name = String(r.name || '').replace(/"/g, '""');
        const status = r.status || '';
        const sentAt = r.sentAt ? new Date(r.sentAt).toISOString() : '';
        const reason = String(r.failureReason || '').replace(/"/g, '""');
        return `"${phone}","${name}","${status}","${sentAt}","${reason}"`;
      });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="campaign-recipients.csv"');
      res.send(header + rows.join('\n'));
      return;
    }
    res.json({ recipients });
  } catch (err) {
    if (err.message === 'Campaign not found') return res.status(404).json({ message: err.message });
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
