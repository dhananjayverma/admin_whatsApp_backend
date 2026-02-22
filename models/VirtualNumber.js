const mongoose = require('mongoose');

const virtualNumberSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    provider: { type: String, default: '' },
    vpnHost: { type: String, default: '' },
    vpnPort: { type: Number, default: null },
    vpnUser: { type: String, default: '' },
    vpnPasswordEncrypted: { type: String, default: '' },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    health: { type: String, enum: ['ok', 'warning', 'fail'], default: 'ok' },
    lastUsedAt: { type: Date, default: null },
    messagesToday: { type: Number, default: 0 },
    messagesTodayResetAt: { type: Date, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

virtualNumberSchema.index({ status: 1, lastUsedAt: 1 });

module.exports = mongoose.model('VirtualNumber', virtualNumberSchema);
