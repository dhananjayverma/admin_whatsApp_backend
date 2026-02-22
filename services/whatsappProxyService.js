const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { decrypt } = require('../utils/encryption');
const { WHATSAPP_API_BASE_URL } = require('../config/env');
const logger = require('../utils/logger');

function buildProxyAgent(numberDoc) {
  const host = numberDoc.vpnHost;
  const port = numberDoc.vpnPort;
  const user = numberDoc.vpnUser || '';
  const encrypted = numberDoc.vpnPasswordEncrypted;
  const pass = encrypted ? decrypt(encrypted) : '';

  if (!host || !port) return null;
  const auth = user && pass ? `${user}:${pass}` : '';
  const protocol = 'https';
  const url = auth ? `${protocol}://${auth}@${host}:${port}` : `${protocol}://${host}:${port}`;
  return new HttpsProxyAgent(url);
}

async function sendMessage(numberDoc, recipientPhone, body) {
  const agent = buildProxyAgent(numberDoc);
  const url = `${WHATSAPP_API_BASE_URL}/send`;
  const payload = JSON.stringify({
    to: recipientPhone.replace(/\D/g, ''),
    body: body || ' ',
  });

  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
  if (numberDoc.meta?.userAgent) headers['User-Agent'] = numberDoc.meta.userAgent;
  if (numberDoc.meta?.fingerprint?.userAgent) headers['User-Agent'] = numberDoc.meta.fingerprint.userAgent;

  return new Promise((resolve, reject) => {
    const opts = { method: 'POST', headers };
    if (agent) opts.agent = agent;

    const req = https.request(url, opts, (res) => {
      let data = '';
      res.on('data', (ch) => (data += ch));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data || '{}'));
          } catch {
            resolve({});
          }
        } else {
          reject(new Error(data || `HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { sendMessage, buildProxyAgent };
