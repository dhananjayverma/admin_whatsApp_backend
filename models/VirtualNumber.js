const mongoose = require('mongoose');

const virtualNumberSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    provider: { type: String, default: '' },
    vpnHost: { type: String, default: '' },
    vpnPort: { type: Number, default: null },
    vpnUser: { type: String, default: '' },
    vpnPasswordEncrypted: { type: String, default: '' },
    status: { type: String, enum: ['active', 'inactive', 'blocked'], default: 'active' },
    health: { type: String, enum: ['ok', 'warning', 'fail'], default: 'ok' },
    lastUsedAt: { type: Date, default: null },
    messagesToday: { type: Number, default: 0 },
    messagesTodayResetAt: { type: Date, default: null },
    consecutiveFailures: { type: Number, default: 0 },
    blockedAt: { type: Date, default: null },
    blockReason: { type: String, default: '' },
    hasWhatsApp: { type: Boolean, default: true },
    whatsappClientId: { type: String, default: '' },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

virtualNumberSchema.index({ status: 1, lastUsedAt: 1 });

module.exports = mongoose.model('VirtualNumber', virtualNumberSchema);
