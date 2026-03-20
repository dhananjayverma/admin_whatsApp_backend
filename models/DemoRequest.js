const mongoose = require('mongoose');

const demoSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['demo', 'ai_generate'], default: 'demo' },
    creditType: { type: String, enum: ['normal', 'r_btn', 'action_btn', 'btn_sms', ''], default: '' },
    userName: { type: String, default: '' },
    phone: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    message: { type: String, default: '' },
    meta: { type: mongoose.Schema.Types.Mixed },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
  },
  { timestamps: true }
);

demoSchema.index({ userId: 1, createdAt: -1 });
demoSchema.index({ status: 1 });
demoSchema.index({ createdAt: -1 });

module.exports = mongoose.model('DemoRequest', demoSchema);
