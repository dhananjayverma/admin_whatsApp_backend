const express = require('express');
const DemoRequest = require('../models/DemoRequest');
const User = require('../models/User');
const { auth } = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');
const { getRedis } = require('../config/redis');

const router = express.Router();

const DEMO_LIMIT_PER_DAY = 2;
const DEMO_START_HOUR = 9;
const DEMO_START_MIN = 30;
const DEMO_END_HOUR = 18;
const DEMO_END_MIN = 0;
const SUNDAY_END_HOUR = 12;
const SUNDAY_END_MIN = 0;

function isWithinDemoWindow() {
  const now = new Date();
  const day = now.getDay();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const totalMins = hours * 60 + minutes;
  const startMins = DEMO_START_HOUR * 60 + DEMO_START_MIN;
  if (day === 0) {
    const endMins = SUNDAY_END_HOUR * 60 + SUNDAY_END_MIN;
    return totalMins >= startMins && totalMins <= endMins;
  }
  const endMins = DEMO_END_HOUR * 60 + DEMO_END_MIN;
  return totalMins >= startMins && totalMins <= endMins;
}

function getDateKey() {
  return new Date().toISOString().slice(0, 10);
}

router.get('/limits', auth, allowRoles('admin', 'reseller', 'client'), async (req, res) => {
  try {
    const redis = getRedis();
    const dateKey = getDateKey();
    const userId = req.user._id.toString();
    const demoKey = `demo:${userId}:${dateKey}`;
    const aiKey = `ai:${userId}:${dateKey}`;

    const [demoCount, aiUsed] = await Promise.all([
      redis.get(demoKey).then((v) => parseInt(v || '0', 10)),
      redis.get(aiKey).then((v) => !!v && v !== '0'),
    ]);

    const canSubmit = isWithinDemoWindow() && demoCount < DEMO_LIMIT_PER_DAY;
    const canAiGenerate = !aiUsed;

    res.json({
      demosToday: demoCount,
      demosLimit: DEMO_LIMIT_PER_DAY,
      canSubmit,
      canAiGenerate,
      aiGenerateUsedToday: aiUsed,
      withinWindow: isWithinDemoWindow(),
      nextReset: `${dateKey} (midnight)`,
    });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.post('/', auth, allowRoles('admin', 'reseller', 'client'), async (req, res) => {
  try {
    if (!isWithinDemoWindow()) {
      return res.status(400).json({ message: 'Demo requests accepted only between 9:30 AM and 6:00 PM (Sunday until 12 PM).' });
    }
    const redis = getRedis();
    const dateKey = getDateKey();
    const demoKey = `demo:${req.user._id}:${dateKey}`;
    const count = parseInt(await redis.get(demoKey).then((v) => v || '0'), 10);
    if (count >= DEMO_LIMIT_PER_DAY) {
      return res.status(400).json({ message: 'Demo limit reached (2 per day). Try again tomorrow.' });
    }

    const { message = '', creditType = '', userName = '', phone = '' } = req.body || {};
    const validCreditTypes = ['normal', 'r_btn', 'action_btn', 'btn_sms'];
    const demo = await DemoRequest.create({
      userId: req.user._id,
      type: 'demo',
      creditType: validCreditTypes.includes(creditType) ? creditType : '',
      userName: String(userName).slice(0, 100),
      phone: String(phone).replace(/\D/g, '').slice(0, 15),
      status: 'pending',
      message: String(message).slice(0, 500),
    });
    await redis.incr(demoKey);
    await redis.expire(demoKey, 86400 * 2);

    res.status(201).json({ request: demo, demosRemaining: DEMO_LIMIT_PER_DAY - count - 1 });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// Client/reseller: list own requests
router.get('/my', auth, allowRoles('admin', 'reseller', 'client'), async (req, res) => {
  try {
    const list = await DemoRequest.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ list });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.get('/', auth, allowRoles('admin'), async (req, res) => {
  try {
    const list = await DemoRequest.find()
      .sort({ createdAt: -1 })
      .limit(200)
      .populate('userId', 'email role')
      .lean();
    res.json({ list });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.patch('/:id', auth, allowRoles('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    const demo = await DemoRequest.findByIdAndUpdate(
      id,
      { status, reviewedBy: req.user._id, reviewedAt: new Date() },
      { new: true }
    ).lean();
    if (!demo) return res.status(404).json({ message: 'Request not found' });
    res.json({ request: demo });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
