const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true },
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'queued', 'running', 'completed', 'paused', 'cancelled'],
      default: 'draft',
    },
    recipientCount: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    creditsUsed: { type: Number, default: 0 },
    messageBody: { type: String, default: '' },
    type: { type: String, enum: ['text', 'button', 'dp'], default: 'text' },
    buttonQuestion: { type: String, default: '' },
    buttonOptions: [{ type: String }],
    scheduledAt: Date,
    startedAt: Date,
    completedAt: Date,
  },
  { timestamps: true }
);

campaignSchema.index({ userId: 1, createdAt: -1 });
campaignSchema.index({ status: 1 });
campaignSchema.index({ scheduledAt: 1 });

module.exports = mongoose.model('Campaign', campaignSchema);
