/**
 * Run: node scripts/seedAdmin.js
 * Creates default admin user: admin@example.com / admin123
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { MONGODB_URI } = require('../config/env');

async function run() {
  await mongoose.connect(MONGODB_URI);
  const existing = await User.findOne({ email: 'admin@example.com' });
  if (existing) {
    console.log('Admin user already exists.');
    process.exit(0);
    return;
  }
  const passwordHash = await bcrypt.hash('admin123', 10);
  await User.create({
    email: 'admin@example.com',
    passwordHash,
    role: 'admin',
    creditBalance: 0,
  });
  console.log('Admin user created: admin@example.com / admin123');
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
