/**
 * Create a new user (email + password).
 * Run: node scripts/createUser.js <email> <password> [role]
 * Role: admin | reseller | client (default: client)
 * Example: node scripts/createUser.js newuser@example.com mypass123 admin
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { MONGODB_URI } = require('../config/env');

async function run() {
  const email = process.argv[2];
  const password = process.argv[3];
  const role = (process.argv[4] || 'client').toLowerCase();

  if (!email || !password) {
    console.error('Usage: node scripts/createUser.js <email> <password> [role]');
    console.error('Example: node scripts/createUser.js newuser@example.com mypass123 admin');
    process.exit(1);
  }

  const validRoles = ['admin', 'reseller', 'client'];
  if (!validRoles.includes(role)) {
    console.error('Role must be: admin, reseller, or client');
    process.exit(1);
  }

  const emailStr = email.trim().toLowerCase();
  if (emailStr.length > 254) {
    console.error('Email too long.');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);

  const existing = await User.findOne({ email: emailStr });
  if (existing) {
    console.error('User with this email already exists.');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await User.create({
    email: emailStr,
    passwordHash,
    role,
    creditBalance: 0,
  });

  console.log('User created:', emailStr, '| role:', role);
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
