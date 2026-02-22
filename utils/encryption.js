const crypto = require('crypto');
const { ENCRYPTION_KEY } = require('../config/env');

const ALGO = 'aes-256-gcm';
const IV_LEN = 16;
const AUTH_TAG_LEN = 16;
const KEY_LEN = 32;

function getKey() {
  const raw = ENCRYPTION_KEY.replace(/[^a-fA-F0-9]/g, '');
  if (raw.length >= KEY_LEN * 2) {
    return Buffer.from(raw.slice(0, KEY_LEN * 2), 'hex');
  }
  return crypto.scryptSync(ENCRYPTION_KEY, 'salt', KEY_LEN);
}

function encrypt(text) {
  if (!text) return '';
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, enc]).toString('base64');
}

function decrypt(cipherText) {
  if (!cipherText) return '';
  const key = getKey();
  const buf = Buffer.from(cipherText, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const authTag = buf.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN);
  const enc = buf.subarray(IV_LEN + AUTH_TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(enc) + decipher.final('utf8');
}

module.exports = { encrypt, decrypt };
