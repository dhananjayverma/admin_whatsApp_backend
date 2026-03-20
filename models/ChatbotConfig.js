const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    key: { type: String, default: 'default', unique: true },
    enabled: { type: Boolean, default: false },
    welcomeMessage: { type: String, default: '' },
    fallbackMessage: { type: String, default: '' },
    rules: { type: mongoose.Schema.Types.Mixed, default: [] }, // [{ keyword, reply }]
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ChatbotConfig', schema);
