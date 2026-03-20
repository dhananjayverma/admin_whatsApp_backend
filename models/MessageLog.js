const mongoose = require('mongoose');

const messageLogSchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true },
    recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Recipient', default: null },
    virtualNumberId: { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualNumber', default: null },
    status: { type: String, enum: ['sent', 'failed'], required: true },
    providerMessageId: String,
    sentAt: { type: Date, default: Date.now },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

messageLogSchema.index({ campaignId: 1, sentAt: -1 });
messageLogSchema.index({ virtualNumberId: 1, sentAt: -1 });

module.exports = mongoose.model('MessageLog', messageLogSchema);
