const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['admin', 'reseller', 'client'], required: true },
    resellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    creditBalance: { type: Number, default: 0 },
  },
  { timestamps: true }
);

userSchema.index({ role: 1 });
userSchema.index({ resellerId: 1 });

module.exports = mongoose.model('User', userSchema);
