const express = require('express');
const Campaign = require('../models/Campaign');
const User = require('../models/User');
const VirtualNumber = require('../models/VirtualNumber');
const { auth } = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');

const router = express.Router();

router.get('/overview', auth, allowRoles('admin', 'reseller', 'client'), async (req, res) => {
  try {
    const user = req.user;
    let campaignFilter = {};
    let userCount = 0;
    let numberCount = 0;

    if (user.role === 'admin') {
      campaignFilter = {};
      userCount = await User.countDocuments({ role: { $in: ['reseller', 'client'] } });
      numberCount = await VirtualNumber.countDocuments({ status: 'active' });
    } else if (user.role === 'reseller') {
      const clientIds = await User.find({ resellerId: user._id }).distinct('_id');
      campaignFilter = { userId: { $in: clientIds } };
      userCount = clientIds.length;
    } else {
      campaignFilter = { userId: user._id };
    }

    const campaigns = await Campaign.find(campaignFilter).lean();
    const totalCampaigns = campaigns.length;
    const totalSent = campaigns.reduce((s, c) => s + (c.sentCount || 0), 0);
    const totalFailed = campaigns.reduce((s, c) => s + (c.failedCount || 0), 0);
    const completed = campaigns.filter((c) => c.status === 'completed').length;
    const running = campaigns.filter((c) => c.status === 'running').length;

    res.json({
      overview: {
        totalCampaigns,
        totalSent,
        totalFailed,
        completed,
        running,
        userCount: user.role === 'client' ? undefined : userCount,
        activeNumbers: user.role === 'admin' ? numberCount : undefined,
      },
      creditBalance: user.creditBalance,
    });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
