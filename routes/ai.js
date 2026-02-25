const express = require('express');
const { auth } = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');
const { getRedis } = require('../config/redis');
const DemoRequest = require('../models/DemoRequest');

const router = express.Router();

router.post('/generate-message', auth, allowRoles('admin', 'reseller', 'client'), async (req, res) => {
  try {
    const redis = getRedis();
    const dateKey = new Date().toISOString().slice(0, 10);
    const aiKey = `ai:${req.user._id}:${dateKey}`;
    const used = await redis.get(aiKey);
    if (used && used !== '0') {
      return res.status(400).json({ message: 'Generate With AI is free once per day. You have already used it today.' });
    }

    const { prompt = '' } = req.body || {};
    const text = String(prompt).slice(0, 500);
    let messageBody = '';
    if (process.env.OPENAI_API_KEY) {
      try {
        const OpenAI = require('openai');
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const completion = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: text || 'Write a short WhatsApp marketing message (1-2 sentences).' }],
          max_tokens: 150,
        });
        messageBody = completion.choices?.[0]?.message?.content?.trim() || '';
      } catch (e) {
        messageBody = 'Hi {{name}}, we have a special offer for you. Reply YES to know more.';
      }
    } else {
      messageBody = 'Hi {{name}}, we have a special offer for you. Reply YES to know more.';
    }

    await redis.set(aiKey, '1', 'EX', 86400 * 2);
    await DemoRequest.create({
      userId: req.user._id,
      type: 'ai_generate',
      status: 'approved',
      meta: { prompt: text },
    });

    res.json({ messageBody });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
