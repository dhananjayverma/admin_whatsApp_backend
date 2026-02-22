const mongoose = require('mongoose');

const recipientSchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true },
    phone: { type: String, required: true },
    name: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' },
    messageId: String,
    sentAt: Date,
    failureReason: String,
    numberUsed: { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualNumber' },
  },
  { timestamps: true }
);

recipientSchema.index({ campaignId: 1, status: 1 });
recipientSchema.index({ campaignId: 1 });
recipientSchema.index({ status: 1, campaignId: 1 });

module.exports = mongoose.model('Recipient', recipientSchema);
