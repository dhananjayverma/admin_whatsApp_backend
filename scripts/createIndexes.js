/**
 * Run: node scripts/createIndexes.js
 * Creates MongoDB indexes as per IMPLEMENTATION-GUIDE.md
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { MONGODB_URI } = require('../config/env');

async function run() {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;

  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('users').createIndex({ role: 1 });
  await db.collection('users').createIndex({ resellerId: 1 });

  await db.collection('campaigns').createIndex({ userId: 1, createdAt: -1 });
  await db.collection('campaigns').createIndex({ status: 1 });
  await db.collection('campaigns').createIndex({ scheduledAt: 1 });

  await db.collection('recipients').createIndex({ campaignId: 1, status: 1 });
  await db.collection('recipients').createIndex({ campaignId: 1 });
  await db.collection('recipients').createIndex({ status: 1, campaignId: 1 });

  await db.collection('credittransactions').createIndex({ userId: 1, createdAt: -1 });

  await db.collection('virtualnumbers').createIndex({ status: 1, lastUsedAt: 1 });
  await db.collection('virtualnumbers').createIndex({ number: 1 }, { unique: true });

  await db.collection('messagelogs').createIndex({ campaignId: 1, sentAt: -1 });

  console.log('Indexes created.');
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
