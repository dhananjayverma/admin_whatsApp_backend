const express = require('express');
const { auth } = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');
const { COST_PER_MESSAGE, CHUNK_SIZE, COOLDOWN_SECONDS, MAX_MESSAGES_PER_NUMBER_PER_DAY } = require('../config/env');

const router = express.Router();

router.get('/', auth, allowRoles('admin'), (req, res) => {
  res.json({
    costPerMessage: COST_PER_MESSAGE,
    chunkSize: CHUNK_SIZE,
    cooldownSeconds: COOLDOWN_SECONDS,
    maxMessagesPerNumberPerDay: MAX_MESSAGES_PER_NUMBER_PER_DAY,
  });
});

module.exports = router;
