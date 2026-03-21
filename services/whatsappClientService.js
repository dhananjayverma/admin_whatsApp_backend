const { Client, LocalAuth, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('../utils/logger');

// IS_CLOUD = true when running on Render/container (Linux, no display)
const IS_CLOUD = process.platform !== 'win32';
const DATA_PATH = IS_CLOUD ? os.tmpdir() : path.join(__dirname, '..');

// Resolve Chrome executable once at startup — explicit path prevents "Chrome not found" loops
function _resolveChromePath() {
  // 1. Explicit override via env (Render dashboard or .env)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  // 2. Use puppeteer's own resolution (reads .puppeteerrc.cjs / PUPPETEER_CACHE_DIR)
  try {
    const p = require('puppeteer').executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  // 3. Common Linux paths (Render / cloud)
  const linuxPaths = [
    '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
  ];
  for (const p of linuxPaths) { if (fs.existsSync(p)) return p; }
  return null;
}
const CHROME_PATH = _resolveChromePath();
if (CHROME_PATH) {
  logger.info(`[WA] Chrome found: ${CHROME_PATH}`);
} else {
  logger.error('[WA] Chrome NOT found — run: npx puppeteer browsers install chrome');
}

// LocalAuth stores sessions at <dataPath>/.wwebjs_auth/session-<clientId>/
// dataPath must be the PARENT of .wwebjs_auth (the backend/ folder)
const AUTH_DIR = path.join(__dirname, '../.wwebjs_auth');

// ── MongoStore (cloud only) ───────────────────────────────────────────────────
let _mongoStore = null;
function _getMongoStore() {
  if (!_mongoStore) {
    const { MongoStore } = require('wwebjs-mongo');
    const mongoose = require('mongoose');
    _mongoStore = new MongoStore({ mongoose });
  }
  return _mongoStore;
}

// ── Chrome / lock helpers ─────────────────────────────────────────────────────

function _spinWait(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

// Kill every Chrome / Chromium process on this machine
function _killAllChrome() {
  if (IS_CLOUD) return;
  try { execSync('taskkill /IM chrome.exe /F /T',   { stdio: 'ignore' }); } catch {}
  try { execSync('taskkill /IM chromium.exe /F /T', { stdio: 'ignore' }); } catch {}
  logger.info('[WA] Killed all Chrome/Chromium processes');
}

// Recursively delete every SingletonLock file under a directory tree
function _deleteLockFiles(dir) {
  if (!fs.existsSync(dir)) return;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        _deleteLockFiles(full);
      } else if (entry.name === 'SingletonLock') {
        try { fs.unlinkSync(full); } catch {}
      }
    }
  } catch {}
}

// Full startup cleanup: kill Chrome then wipe every lock in .wwebjs_auth tree
async function _fullCleanup() {
  if (IS_CLOUD) return;
  _killAllChrome();
  await new Promise((r) => setTimeout(r, 800)); // async wait — does NOT block event loop
  _deleteLockFiles(AUTH_DIR);
  logger.info('[WA] Startup cleanup complete');
}

// Per-session lock clear before creating a client
function _clearSessionLock(clientId) {
  if (IS_CLOUD) return;
  // Lock lives at AUTH_DIR/session-<clientId>/SingletonLock
  const lockPath = path.join(AUTH_DIR, `session-${clientId}`, 'SingletonLock');
  if (!fs.existsSync(lockPath)) return;

  _killAllChrome();
  _spinWait(1500);

  for (let i = 0; i < 10; i++) {
    if (!fs.existsSync(lockPath)) break;
    try { fs.unlinkSync(lockPath); break; } catch { _spinWait(200); }
  }

  if (!fs.existsSync(lockPath)) {
    logger.info(`[WA:${clientId}] Cleared stale session lock`);
  } else {
    logger.warn(`[WA:${clientId}] Could not remove lock — Chrome may still hold it`);
  }
}

// ── Session map ───────────────────────────────────────────────────────────────
const clients     = new Map();   // clientId → state
const _restarting = new Set();   // clientIds currently in restart cycle
let rrIndex = 0;

const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--disable-sync',
  '--disable-translate',
  '--disable-default-apps',
  '--disable-hang-monitor',
  '--disable-client-side-phishing-detection',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required',
  // NOTE: --disable-background-networking REMOVED — WhatsApp needs background network access
  ...(IS_CLOUD ? ['--single-process'] : []),
];

// ── Private ───────────────────────────────────────────────────────────────────

function _restartClient(clientId) {
  const state = clients.get(clientId);
  if (!state || state.status === 'ready' || _restarting.has(clientId)) return;
  if (state.restartCount >= 10) {
    logger.error(`[WA:${clientId}] Max restart attempts reached. Use reconnect to reset.`);
    state.status = 'disconnected';
    return;
  }

  _restarting.add(clientId);
  logger.info(`[WA:${clientId}] Auto-restarting (attempt ${state.restartCount + 1})...`);
  const { label, phone, restartCount } = state;

  try { state.client?.removeAllListeners(); } catch {}

  const doRestart = () => {
    _clearSessionLock(clientId);
    clients.delete(clientId);
    _restarting.delete(clientId);
    _createClient(clientId, label, phone, restartCount + 1);
  };

  if (state.launched) {
    state.client?.destroy().catch(() => {}).then(() => setTimeout(doRestart, 2000));
  } else {
    setTimeout(doRestart, 3000);
  }
}

function _createClient(clientId, label, phone, restartCount = 0) {
  if (clients.has(clientId)) return;

  // Always clear any stale lock before launching
  _clearSessionLock(clientId);

  const state = {
    clientId,
    label:        label || '',
    phone:        phone || '',
    status:       'loading',
    qr:           null,
    client:       null,
    restartCount,
    launched:     false,
  };
  clients.set(clientId, state);

  // Use RemoteAuth (MongoDB) only when explicitly configured via env
  const USE_REMOTE_AUTH = !!process.env.MONGODB_SESSION_STORE;
  const authStrategy = USE_REMOTE_AUTH
    ? new RemoteAuth({
        clientId,
        store:                _getMongoStore(),
        backupSyncIntervalMs: 300000,
        dataPath:             DATA_PATH,
      })
    : new LocalAuth({
        clientId,
        dataPath: path.join(__dirname, '..'),  // sessions → backend/.wwebjs_auth/session-<id>/
      });

  if (!CHROME_PATH) {
    logger.error(`[WA:${clientId}] Cannot start — Chrome not installed. Run: npx puppeteer browsers install chrome`);
    state.status = 'disconnected';
    clients.delete(clientId);
    return;
  }
  const puppeteerConfig = { headless: true, args: PUPPETEER_ARGS, executablePath: CHROME_PATH };

  const c = new Client({
    authStrategy,
    puppeteer: puppeteerConfig,
    webVersionCache: {
      type: 'local',
      path: path.join(__dirname, '../.wwebjs_cache'),
    },
  });
  state.client = c;

  c.on('qr', async (qr) => {
    state.launched = true;
    state.status   = 'qr';
    try { state.qr = await qrcode.toDataURL(qr); } catch { state.qr = null; }
    logger.info(`[WA:${clientId}] QR ready — scan now`);
  });

  c.on('authenticated', () => {
    state.launched     = true;
    state.status       = 'ready';
    state.qr           = null;
    state.restartCount = 0;
    logger.info(`[WA:${clientId}] Authenticated`);
    if (clientId.startsWith('vn_')) {
      const VirtualNumber = require('../models/VirtualNumber');
      VirtualNumber.updateOne(
        { _id: clientId.replace('vn_', '') },
        { $set: { hasWhatsApp: true } }
      ).catch(() => {});
    }
  });

  c.on('ready', () => {
    state.launched     = true;
    state.status       = 'ready';
    state.qr           = null;
    state.restartCount = 0;
    logger.info(`[WA:${clientId}] Ready`);
  });

  c.on('remote_session_saved', () => {
    logger.info(`[WA:${clientId}] Session saved to MongoDB`);
  });

  c.on('auth_failure', () => {
    state.status = 'disconnected';
    logger.error(`[WA:${clientId}] Auth failure`);
    setTimeout(() => _restartClient(clientId), 15000);
  });

  c.on('disconnected', (reason) => {
    state.status = 'disconnected';
    state.qr     = null;
    logger.warn(`[WA:${clientId}] Disconnected: ${reason}`);
    setTimeout(() => _restartClient(clientId), 10000);
  });

  c.initialize().catch((err) => {
    state.status = 'disconnected';
    logger.error(`[WA:${clientId}] Init error: ${err.message}`);
    if (err.message?.includes('already running')) {
      // Force-clear everything so next retry succeeds
      _killAllChrome();
      _deleteLockFiles(AUTH_DIR);
    }
    setTimeout(() => _restartClient(clientId), 15000);
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

async function initAll() {
  const WhatsAppAccount = require('../models/WhatsAppAccount');
  let accounts = await WhatsAppAccount.find().lean();

  const adminAccounts  = accounts.filter((a) => !a.clientId.startsWith('user_'));
  const clientAccounts = accounts.filter((a) =>  a.clientId.startsWith('user_'));

  if (adminAccounts.length === 0) {
    await WhatsAppAccount.create({ clientId: 'default', label: 'Account 1' });
    adminAccounts.push({ clientId: 'default', label: 'Account 1', phone: '' });
    logger.info('[WA] Created default account');
  }

  if (!IS_CLOUD) {
    await _fullCleanup();
  }

  logger.info(`[WA] Using ${process.env.MONGODB_SESSION_STORE ? 'RemoteAuth (MongoDB)' : 'LocalAuth'} strategy`);

  for (let i = 0; i < adminAccounts.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 4000));
    _createClient(adminAccounts[i].clientId, adminAccounts[i].label, adminAccounts[i].phone);
  }
  logger.info(`[WA] Initialized ${adminAccounts.length} admin account(s)`);

  if (clientAccounts.length > 0) {
    const offset = adminAccounts.length * 4000 + 4000;
    clientAccounts.forEach((a, i) => {
      setTimeout(() => _createClient(a.clientId, a.label, a.phone), offset + i * 4000);
    });
    logger.info(`[WA] Scheduling ${clientAccounts.length} user session(s)`);
  }
}

async function addAccount(label) {
  const WhatsAppAccount = require('../models/WhatsAppAccount');
  const clientId     = 'wa_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const accountLabel = label || `Account ${clients.size + 1}`;
  await WhatsAppAccount.create({ clientId, label: accountLabel });
  _createClient(clientId, accountLabel, '');
  return clientId;
}

async function removeAccount(clientId) {
  const WhatsAppAccount = require('../models/WhatsAppAccount');
  const state = clients.get(clientId);
  if (state) {
    try { state.client?.removeAllListeners(); } catch {}
    if (state.launched) {
      await state.client?.logout().catch(() => {});
      await state.client?.destroy().catch(() => {});
    }
    clients.delete(clientId);
  }
  await WhatsAppAccount.deleteOne({ clientId });
}

async function reconnectAccount(clientId) {
  const WhatsAppAccount = require('../models/WhatsAppAccount');
  const state = clients.get(clientId);
  const doc   = await WhatsAppAccount.findOne({ clientId }).lean();
  if (state) {
    try { state.client?.removeAllListeners(); } catch {}
    if (state.launched) {
      await state.client?.logout().catch(() => {});
      await state.client?.destroy().catch(() => {});
    }
    clients.delete(clientId);
    _clearSessionLock(clientId);
    await new Promise((r) => setTimeout(r, 2000));
  }
  _createClient(clientId, doc?.label || '', doc?.phone || '', 0);
}

async function updateAccount(clientId, { label, phone } = {}) {
  const WhatsAppAccount = require('../models/WhatsAppAccount');
  const state = clients.get(clientId);
  if (!state) throw new Error('Account not found');
  const update = {};
  if (label !== undefined) { update.label = label; state.label = label; }
  if (phone  !== undefined) { update.phone  = phone;  state.phone  = phone;  }
  await WhatsAppAccount.updateOne({ clientId }, update);
}

function getAllStatus() {
  return Array.from(clients.values()).map(({ clientId, label, phone, status, qr }) => ({
    clientId, label, phone, status, qr,
  }));
}

function getStatus() {
  const first = clients.values().next().value;
  return first ? { status: first.status, qr: first.qr } : { status: 'loading', qr: null };
}

async function sendViaClientId(clientId, phone, message, mediaPath) {
  const state = clients.get(clientId);
  if (!state || state.status !== 'ready' || !state.client)
    throw new Error(`WhatsApp account ${clientId} is not ready (status: ${state?.status || 'not found'})`);

  const chatId = phone.replace(/\D/g, '') + '@c.us';
  try {
    if (mediaPath && fs.existsSync(mediaPath)) {
      const media = MessageMedia.fromFilePath(mediaPath);
      await state.client.sendMessage(chatId, media, { caption: message || '' });
    } else {
      await state.client.sendMessage(chatId, message);
    }
  } catch (err) {
    const isCrash = err.message && (
      err.message.includes('Target closed') || err.message.includes('Protocol error') ||
      err.message.includes('Session closed') || err.name === 'TargetCloseError'
    );
    if (isCrash) {
      state.status = 'disconnected'; state.qr = null;
      logger.warn(`[WA:${clientId}] Client crashed during send — restarting`);
      setTimeout(() => _restartClient(clientId), 5000);
    }
    throw err;
  }
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
  if (!clients.has(clientId)) _createClient(clientId, label, phoneLabel || '');
  await VirtualNumber.updateOne(
    { _id: virtualNumberId },
    { $set: { whatsappClientId: clientId, hasWhatsApp: false } }
  );
  logger.info(`[WA] Provisioned session for ${phoneLabel}`, { clientId });
  return clientId;
}

async function sendMessage(phone, message, mediaPath) {
  const ready = Array.from(clients.values()).filter((s) => s.status === 'ready' && s.client);
  if (ready.length === 0) throw new Error('No WhatsApp account connected. Please scan the QR code.');

  const idx    = rrIndex % ready.length;
  rrIndex      = (rrIndex + 1) % Math.max(ready.length, 1);
  const state  = ready[idx];
  const chatId = phone.replace(/\D/g, '') + '@c.us';

  try {
    if (mediaPath && fs.existsSync(mediaPath)) {
      const media = MessageMedia.fromFilePath(mediaPath);
      await state.client.sendMessage(chatId, media, { caption: message || '' });
    } else {
      await state.client.sendMessage(chatId, message);
    }
  } catch (err) {
    const isCrash = err.message && (
      err.message.includes('Target closed') || err.message.includes('Protocol error') ||
      err.message.includes('Session closed') || err.name === 'TargetCloseError'
    );
    if (isCrash) {
      state.status = 'disconnected'; state.qr = null;
      logger.warn(`[WA:${state.clientId}] Client crashed during send — restarting`);
      setTimeout(() => _restartClient(state.clientId), 5000);
    }
    throw err;
  }
}

function _startClientForUser(clientId, label) {
  _createClient(clientId, label, '', 0);
}

module.exports = {
  initAll, addAccount, removeAccount, reconnectAccount, updateAccount,
  getAllStatus, getStatus, sendMessage, sendViaClientId, provisionWhatsApp,
  _startClientForUser,
};
