const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['admin', 'reseller', 'client'], required: true },
    resellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    creditBalance: { type: Number, default: 0 },
    rBtnCredit: { type: Number, default: 0 },
    actionBtnCredit: { type: Number, default: 0 },
    btnSmsCredit: { type: Number, default: 0 },
    apiDaysCredit: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    // null = all sections visible; array of keys = only those sections shown
    enabledSections: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

userSchema.index({ role: 1 });
userSchema.index({ resellerId: 1 });

module.exports = mongoose.model('User', userSchema);
