/**
 * Lightweight validation/sanitization for API inputs.
 * - Rejects oversized body
 * - Sanitizes string length where needed (handled in services)
 */

const MAX_BODY_LENGTH = 10 * 1024 * 1024; // 10MB already set in express.json

function validateCampaignBody(req, res, next) {
  const body = req.body || {};
  if (body.name !== undefined && typeof body.name !== 'string') {
    return res.status(400).json({ message: 'Invalid campaign name' });
  }
  if (body.messageBody !== undefined && typeof body.messageBody !== 'string') {
    return res.status(400).json({ message: 'Invalid message body' });
  }
  if (body.type !== undefined && !['text', 'button', 'dp'].includes(body.type)) {
    return res.status(400).json({ message: 'Invalid campaign type' });
  }
  if (body.buttonQuestion !== undefined && typeof body.buttonQuestion !== 'string') {
    return res.status(400).json({ message: 'Invalid button question' });
  }
  if (body.buttonOptions !== undefined && !Array.isArray(body.buttonOptions)) {
    return res.status(400).json({ message: 'Invalid button options' });
  }
  next();
}

function validateCreditPurchase(req, res, next) {
  const body = req.body || {};
  const amount = parseInt(body.amount, 10);
  if (!body.userId || !Number.isInteger(amount) || amount <= 0 || amount > 10000000) {
    return res.status(400).json({ message: 'Valid userId and amount (1–10000000) required' });
  }
  next();
}

function validateMongoId(paramName = 'id') {
  return (req, res, next) => {
    const id = req.params[paramName];
    if (!id || !/^[a-fA-F0-9]{24}$/.test(id)) {
      return res.status(400).json({ message: 'Invalid ID' });
    }
    next();
  };
}

module.exports = {
  validateCampaignBody,
  validateCreditPurchase,
  validateMongoId,
};
