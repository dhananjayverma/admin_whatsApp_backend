const mongoose = require('mongoose');

const apiKeySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    // Stored as plain text — 48-byte hex (96 chars) is effectively unguessable
    key: { type: String, required: true, unique: true },
    // Show only first 8 chars in listings so full key is never exposed again
    keyPrefix: { type: String, required: true },
    active: { type: Boolean, default: true },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

apiKeySchema.index({ userId: 1, active: 1 });

module.exports = mongoose.model('ApiKey', apiKeySchema);
