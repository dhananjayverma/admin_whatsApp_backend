const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const logger = require('../utils/logger');

// Baileys is ESM-only — load once and cache
let _baileys = null;
async function _getBaileys() {
  if (!_baileys) _baileys = await import('@whiskeysockets/baileys');
  return _baileys;
}

// Use persistent disk path on cloud (set BAILEYS_AUTH_PATH in env), else local folder
const AUTH_DIR = process.env.BAILEYS_AUTH_PATH || path.join(__dirname, '../.baileys_auth');

if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// Silent pino logger so Baileys doesn't flood console
let _pino;
try {
  _pino = require('pino')({ level: 'silent' });
} catch {
  _pino = { level: 'silent', child: () => _pino, trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} };
}

// Emits 'update' on every state change — consumed by SSE endpoints
const waEvents = new EventEmitter();
waEvents.setMaxListeners(200);

const clients     = new Map();
const _restarting = new Set();
let rrIndex = 0;

function _sessionDir(clientId) {
  return path.join(AUTH_DIR, `session-${clientId}`);
}

function _emit(clientId) {
  waEvents.emit('update', { clientId, state: clients.get(clientId) || null });
}

function _clearAuthState(clientId) {
  const dir = _sessionDir(clientId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

function _getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif',  '.webp': 'image/webp',  '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',   '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return map[ext] || 'application/octet-stream';
}

function _buildMediaContent(filePath, caption) {
  const mime = _getMimeType(filePath);
  const data = fs.readFileSync(filePath);
  if (mime.startsWith('image/')) return { image: data, mimetype: mime, caption: caption || '' };
  if (mime.startsWith('video/')) return { video: data, mimetype: mime, caption: caption || '' };
  if (mime.startsWith('audio/')) return { audio: data, mimetype: mime, ptt: false };
  return { document: data, mimetype: mime, fileName: path.basename(filePath), caption: caption || '' };
}

async function _createClient(clientId, label, phone, restartCount = 0) {
  if (clients.has(clientId)) return;

  const sessionDir = _sessionDir(clientId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const state = {
    clientId,
    label:        label || '',
    phone:        phone || '',
    status:       'loading',
    qr:           null,
    pairingCode:  null,
    sock:         null,
    restartCount,
    launched:     false,
  };
  clients.set(clientId, state);
  _emit(clientId);

  try {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason: DR, fetchLatestBaileysVersion } = await _getBaileys();

    const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    const sock = makeWASocket({
      version,
      auth:               authState,
      printQRInTerminal:  false,
      logger:             _pino,
      browser:            ['Chrome (Linux)', 'Chrome', '120.0.0.0'],
      syncFullHistory:    false,
      markOnlineOnConnect: false,
    });
    state.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        state.launched = true;
        state.status   = 'qr';
        try { state.qr = await qrcode.toDataURL(qr); } catch { state.qr = null; }
        logger.info(`[WA:${clientId}] QR ready`);
        _emit(clientId);
      }

      if (connection === 'open') {
        state.launched     = true;
        state.status       = 'ready';
        state.qr           = null;
        state.pairingCode  = null;
        state.restartCount = 0;
        logger.info(`[WA:${clientId}] Connected`);
        _emit(clientId);

        if (clientId.startsWith('vn_')) {
          const VirtualNumber = require('../models/VirtualNumber');
          VirtualNumber.updateOne(
            { _id: clientId.replace('vn_', '') },
            { $set: { hasWhatsApp: true } }
          ).catch(() => {});
        }
      }

      if (connection === 'close') {
        const statusCode    = lastDisconnect?.error?.output?.statusCode;
        const loggedOut     = statusCode === DR.loggedOut;
        const replaced      = statusCode === DR.connectionReplaced;

        state.status      = 'disconnected';
        state.qr          = null;
        state.pairingCode = null;
        logger.warn(`[WA:${clientId}] Closed (code ${statusCode})`);
        _emit(clientId);

        if (loggedOut || replaced) {
          // Clear auth so next start shows a fresh QR
          _clearAuthState(clientId);
          logger.info(`[WA:${clientId}] Logged out — auth cleared`);
        }

        clients.delete(clientId);
        _restarting.delete(clientId);

        if (restartCount < 10) {
          const delay = loggedOut ? 2000 : 10000;
          setTimeout(() => _createClient(clientId, label, phone, restartCount + 1), delay);
        } else {
          logger.error(`[WA:${clientId}] Max restarts reached — call reconnect to reset`);
        }
      }
    });

  } catch (err) {
    state.status = 'disconnected';
    logger.error(`[WA:${clientId}] Init error: ${err.message}`);
    _emit(clientId);
    clients.delete(clientId);
    if (restartCount < 10) {
      setTimeout(() => _createClient(clientId, label, phone, restartCount + 1), 15000);
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

async function initAll() {
  const WhatsAppAccount = require('../models/WhatsAppAccount');
  const accounts = await WhatsAppAccount.find().lean();

  const adminAccounts  = accounts.filter((a) => !a.clientId.startsWith('user_'));
  const clientAccounts = accounts.filter((a) =>  a.clientId.startsWith('user_'));

  if (adminAccounts.length === 0) {
    await WhatsAppAccount.create({ clientId: 'default', label: 'Account 1' });
    adminAccounts.push({ clientId: 'default', label: 'Account 1', phone: '' });
    logger.info('[WA] Created default account');
  }

  for (let i = 0; i < adminAccounts.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2000));
    await _createClient(adminAccounts[i].clientId, adminAccounts[i].label, adminAccounts[i].phone);
  }
  logger.info(`[WA] Initialized ${adminAccounts.length} admin account(s)`);

  if (clientAccounts.length > 0) {
    clientAccounts.forEach((a, i) => {
      setTimeout(() => _createClient(a.clientId, a.label, a.phone), (i + 1) * 2000);
    });
    logger.info(`[WA] Scheduling ${clientAccounts.length} user session(s)`);
  }
}

async function addAccount(label) {
  const WhatsAppAccount = require('../models/WhatsAppAccount');
  const clientId     = 'wa_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const accountLabel = label || `Account ${clients.size + 1}`;
  await WhatsAppAccount.create({ clientId, label: accountLabel });
  await _createClient(clientId, accountLabel, '');
  return clientId;
}

async function removeAccount(clientId) {
  const WhatsAppAccount = require('../models/WhatsAppAccount');
  const state = clients.get(clientId);
  if (state?.sock) {
    try {
      state.sock.ev.removeAllListeners();
      if (state.status === 'ready') {
        await state.sock.logout().catch(() => {});
      } else {
        state.sock.end(undefined);
      }
    } catch {}
  }
  clients.delete(clientId);
  _emit(clientId);
  await WhatsAppAccount.deleteOne({ clientId });
}

async function reconnectAccount(clientId) {
  const WhatsAppAccount = require('../models/WhatsAppAccount');
  const doc   = await WhatsAppAccount.findOne({ clientId }).lean();
  if (!doc) throw new Error(`Account ${clientId} not found`);

  const state = clients.get(clientId);
  if (state?.sock) {
    try {
      state.sock.ev.removeAllListeners();
      state.sock.end(undefined);
    } catch {}
  }
  clients.delete(clientId);
  _restarting.delete(clientId);

  // Clear auth so a fresh QR is shown
  _clearAuthState(clientId);

  await _createClient(clientId, doc.label || '', doc.phone || '', 0);
}

async function updateAccount(clientId, { label, phone } = {}) {
  const WhatsAppAccount = require('../models/WhatsAppAccount');
  const state = clients.get(clientId);
  if (!state) throw new Error('Account not found');
  const update = {};
  if (label !== undefined) { update.label = label; state.label = label; }
  if (phone  !== undefined) { update.phone  = phone;  state.phone  = phone;  }
  await WhatsAppAccount.updateOne({ clientId }, update);
  _emit(clientId);
}

function getAllStatus() {
  return Array.from(clients.values()).map(({ clientId, label, phone, status, qr, pairingCode }) => ({
    clientId, label, phone, status, qr, pairingCode,
  }));
}

async function requestPairingCode(clientId, phone) {
  const state = clients.get(clientId);
  if (!state || !state.sock) throw new Error('Session not started yet — try again in a moment');
  if (state.status === 'ready')  throw new Error('Already connected');

  const cleanPhone = phone.replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 7) throw new Error('Invalid phone number');

  try {
    const code = await state.sock.requestPairingCode(cleanPhone);
    state.pairingCode = code;
    state.status      = 'pairing';
    state.qr          = null;
    logger.info(`[WA:${clientId}] Pairing code sent to ${cleanPhone}`);
    _emit(clientId);
    return code;
  } catch (err) {
    throw new Error(`Pairing code failed: ${err.message}`);
  }
}

function getStatus() {
  const first = clients.values().next().value;
  return first ? { status: first.status, qr: first.qr } : { status: 'loading', qr: null };
}

async function _doSend(sock, phone, message, mediaPath) {
  const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
  if (mediaPath && fs.existsSync(mediaPath)) {
    await sock.sendMessage(jid, _buildMediaContent(mediaPath, message));
  } else {
    await sock.sendMessage(jid, { text: message });
  }
}

async function sendViaClientId(clientId, phone, message, mediaPath) {
  const state = clients.get(clientId);
  if (!state || state.status !== 'ready' || !state.sock)
    throw new Error(`WhatsApp account ${clientId} is not ready (status: ${state?.status || 'not found'})`);
  await _doSend(state.sock, phone, message, mediaPath);
}

async function sendMessage(phone, message, mediaPath) {
  const ready = Array.from(clients.values()).filter((s) => s.status === 'ready' && s.sock);
  if (ready.length === 0) throw new Error('No WhatsApp account connected. Please scan the QR code.');

  const idx   = rrIndex % ready.length;
  rrIndex     = (rrIndex + 1) % Math.max(ready.length, 1);
  await _doSend(ready[idx].sock, phone, message, mediaPath);
}

async function provisionWhatsApp(virtualNumberId, phoneLabel) {
  const VirtualNumber   = require('../models/VirtualNumber');
  const WhatsAppAccount = require('../models/WhatsAppAccount');
  const clientId = 'vn_' + virtualNumberId.toString();
  const label    = `Virtual: ${phoneLabel || virtualNumberId}`;
  await WhatsAppAccount.updateOne(
    { clientId },
    { $setOnInsert: { clientId, label, phone: phoneLabel || '' } },
    { upsert: true }
  );
  if (!clients.has(clientId)) await _createClient(clientId, label, phoneLabel || '');
  await VirtualNumber.updateOne(
    { _id: virtualNumberId },
    { $set: { whatsappClientId: clientId, hasWhatsApp: false } }
  );
  logger.info(`[WA] Provisioned ${phoneLabel}`, { clientId });
  return clientId;
}

function _startClientForUser(clientId, label) {
  _createClient(clientId, label, '', 0);
}

module.exports = {
  initAll, addAccount, removeAccount, reconnectAccount, updateAccount,
  getAllStatus, getStatus, sendMessage, sendViaClientId, provisionWhatsApp,
  requestPairingCode, _startClientForUser, waEvents,
};
