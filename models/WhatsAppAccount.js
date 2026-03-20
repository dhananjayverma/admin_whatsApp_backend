const mongoose = require('mongoose');

const whatsAppAccountSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, unique: true },
    label: { type: String, default: '' },
    phone: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('WhatsAppAccount', whatsAppAccountSchema);
