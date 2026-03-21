const { Client, LocalAuth, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, exec } = require('child_process');
const logger = require('../utils/logger');

// ── cloud vs local detection ──────────────────────────────────────────────────
// When PUPPETEER_EXECUTABLE_PATH is set we're on a cloud/container host (Render etc.)
// and must use RemoteAuth (MongoDB-backed) so sessions survive redeploys.
const IS_CLOUD = !!process.env.PUPPETEER_EXECUTABLE_PATH;

// For RemoteAuth temp files — use /tmp on cloud (always writable), local dir otherwise
const DATA_PATH = IS_CLOUD ? os.tmpdir() : path.join(__dirname, '..');

// Lazy MongoStore — only required when IS_CLOUD so wwebjs-mongo isn't needed locally
let _mongoStore = null;
function _getMongoStore() {
  if (!_mongoStore) {
    const { MongoStore } = require('wwebjs-mongo');
    const mongoose = require('mongoose');
    _mongoStore = new MongoStore({ mongoose });
  }
  return _mongoStore;
}

// ── helpers ───────────────────────────────────────────────────────────────────

const AUTH_DIR = path.join(__dirname, '../.wwebjs_auth');

// Kill any chrome.exe process that owns a specific session dir, then delete the lock
function _clearSessionLock(clientId) {
  try {
    const sessionDir = path.join(AUTH_DIR, `session-${clientId}`);
    const lockPath   = path.join(sessionDir, 'SingletonLock');
    if (!fs.existsSync(lockPath)) return;

    // Use wmic to find chrome processes that reference this session directory
    try {
      const normalised = sessionDir.replace(/\//g, '\\');
      const out = execSync(
        `wmic process where "name='chrome.exe'" get ProcessId,CommandLine /format:csv 2>nul`,
        { timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).toString();

      out.split('\n').forEach((line) => {
        if (!line.includes(normalised) && !line.includes(normalised.toLowerCase())) return;
        const parts = line.split(',');
        const pid = parseInt(parts[parts.length - 1], 10);
        if (pid && !isNaN(pid)) {
          try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch { /* already dead */ }
        }
      });
    } catch { /* wmic unavailable or timeout */ }

    // Retry deleting the lock file up to 10 times over 2s
    for (let i = 0; i < 10; i++) {
      try {
        if (!fs.existsSync(lockPath)) break;
        fs.unlinkSync(lockPath);
        logger.info(`[WA:${clientId}] Removed stale SingletonLock`);
        break;
      } catch {
        // Synchronous 200ms wait before retry
        const t = Date.now() + 200;
        while (Date.now() < t) { /* spin */ }
      }
    }
  } catch { /* ignore */ }
}

// Kill ALL chrome.exe processes on this machine (used once at startup to clear orphans)
function _killAllChrome() {
  if (IS_CLOUD) return; // not needed on Linux cloud hosts
  try {
    execSync('taskkill /IM chrome.exe /F /T', { stdio: 'ignore' });
    logger.info('[WA] Cleared all orphaned Chrome processes');
  } catch { /* no chrome running — fine */ }
}

// Delete every SingletonLock file under .wwebjs_auth
function _deleteAllLocks() {
  if (IS_CLOUD) return; // RemoteAuth doesn't use this dir on cloud
  try {
    if (!fs.existsSync(AUTH_DIR)) return;
    const sessions = fs.readdirSync(AUTH_DIR);
    sessions.forEach((dir) => {
      const lock = path.join(AUTH_DIR, dir, 'SingletonLock');
      try { if (fs.existsSync(lock)) { fs.unlinkSync(lock); } } catch { /* ignore */ }
    });
    logger.info('[WA] Deleted all stale lock files');
  } catch { /* ignore */ }
}

// ── session map ───────────────────────────────────────────────────────────────

const clients    = new Map();  // clientId → state
const _restarting = new Set(); // clientIds currently being restarted
let rrIndex = 0;

const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--single-process',        // required on some cloud/container hosts
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--metrics-recording-only',
  '--mute-audio',
  '--disable-software-rasterizer',
];

// ── private ───────────────────────────────────────────────────────────────────

function _restartClient(clientId) {
  const state = clients.get(clientId);
  if (!state) return;
  if (state.status === 'ready') return;
  if (_restarting.has(clientId)) return;        // already restarting
  if (state.restartCount >= 10) {
    logger.error(`[WA:${clientId}] Max restart attempts reached. Manual reconnect required.`);
    state.status = 'disconnected';
    return;
  }

  _restarting.add(clientId);
  logger.info(`[WA:${clientId}] Auto-restarting (attempt ${state.restartCount + 1})…`);
  const { label, phone, restartCount } = state;

  try { state.client?.removeAllListeners(); } catch { /* ignore */ }

  const doRestart = () => {
    _clearSessionLock(clientId);
    clients.delete(clientId);
    _restarting.delete(clientId);
    _createClient(clientId, label, phone, restartCount + 1);
  };

  if (state.launched) {
    // Browser was running — destroy it properly first, then restart
    state.client?.destroy().catch(() => {}).then(() => {
      setTimeout(doRestart, 1500);
    });
  } else {
    // Browser never launched — just clear the lock and retry
    doRestart();
  }
}

function _createClient(clientId, label, phone, restartCount = 0) {
  if (clients.has(clientId)) return;

  // Remove any leftover lock before starting (local only)
  _clearSessionLock(clientId);

  const state = {
    clientId,
    label:        label || '',
    phone:        phone || '',
    status:       'loading',
    qr:           null,
    client:       null,
    restartCount,
    launched:     false,  // set true once a QR or ready event fires
  };
  clients.set(clientId, state);

  // Choose auth strategy based on environment
  const authStrategy = IS_CLOUD
    ? new RemoteAuth({
        clientId,
        store:                _getMongoStore(),
        backupSyncIntervalMs: 300000,   // sync every 5 minutes
        dataPath:             DATA_PATH,
      })
    : new LocalAuth({ clientId });

  const puppeteerConfig = { headless: true, args: PUPPETEER_ARGS };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const c = new Client({
    authStrategy,
    puppeteer: puppeteerConfig,
    webVersionCache: {
      type:       'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
  });
  state.client = c;

  c.on('qr', async (qr) => {
    state.launched = true;
    state.status   = 'qr';
    try { state.qr = await qrcode.toDataURL(qr); } catch { state.qr = null; }
    logger.info(`[WA:${clientId}] QR ready`);
  });

  c.on('authenticated', () => {
    state.launched      = true;
    state.status        = 'ready';
    state.qr            = null;
    state.restartCount  = 0;
    logger.info(`[WA:${clientId}] authenticated`);
    if (clientId.startsWith('vn_')) {
      const VirtualNumber = require('../models/VirtualNumber');
      VirtualNumber.updateOne({ _id: clientId.replace('vn_', '') }, { $set: { hasWhatsApp: true } }).catch(() => {});
    }
  });

  c.on('ready', () => {
    state.launched     = true;
    state.status       = 'ready';
    state.qr           = null;
    state.restartCount = 0;
    logger.info(`[WA:${clientId}] ready`);
  });

  // RemoteAuth fires this after saving the session to MongoDB
  c.on('remote_session_saved', () => {
    logger.info(`[WA:${clientId}] Session saved to MongoDB`);
  });

  c.on('auth_failure', () => {
    state.status = 'disconnected';
    logger.error(`[WA:${clientId}] auth failure`);
    setTimeout(() => _restartClient(clientId), 15000);
  });

  c.on('disconnected', (r) => {
    state.status = 'disconnected';
    state.qr     = null;
    logger.warn(`[WA:${clientId}] disconnected: ${r}`);
    setTimeout(() => _restartClient(clientId), 10000);
  });

  c.initialize().catch((err) => {
    state.status = 'disconnected';
    logger.error(`[WA:${clientId}] init error: ${err.message}`);
    setTimeout(() => _restartClient(clientId), 15000);
  });
}

// ── public ────────────────────────────────────────────────────────────────────

async function initAll() {
  const WhatsAppAccount = require('../models/WhatsAppAccount');
  let accounts = await WhatsAppAccount.find().lean();

  const adminAccounts  = accounts.filter((a) => !a.clientId.startsWith('user_'));
  const clientAccounts = accounts.filter((a) => a.clientId.startsWith('user_'));

  if (adminAccounts.length === 0) {
    await WhatsAppAccount.create({ clientId: 'default', label: 'Account 1' });
    adminAccounts.push({ clientId: 'default', label: 'Account 1', phone: '' });
    logger.info('[WA] Created default account');
  }

  if (!IS_CLOUD) {
    // ① Kill every orphaned Chrome process from previous runs (Windows only)
    _killAllChrome();
    // ② Delete every stale lock file (LocalAuth only)
    _deleteAllLocks();
    // ③ Short pause so OS fully releases file handles after the kills
    await new Promise((r) => setTimeout(r, 1500));
  }

  logger.info(`[WA] Using ${IS_CLOUD ? 'RemoteAuth (MongoDB)' : 'LocalAuth'} strategy`);

  // ④ Start admin accounts one at a time, 3 s apart — avoids simultaneous Chrome launches
  for (let i = 0; i < adminAccounts.length; i++) {
    const a = adminAccounts[i];
    if (i > 0) await new Promise((r) => setTimeout(r, 3000));
    _createClient(a.clientId, a.label, a.phone);
  }
  logger.info(`[WA] Initialized ${adminAccounts.length} admin account(s)`);

  // ⑤ Restore client sessions with an extra offset so they don't compete with admin ones
  if (clientAccounts.length > 0) {
    const offset = adminAccounts.length * 3000 + 3000;
    clientAccounts.forEach((a, i) => {
      setTimeout(() => _createClient(a.clientId, a.label, a.phone), offset + i * 3000);
    });
    logger.info(`[WA] Scheduling ${clientAccounts.length} client session(s)`);
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
    try { state.client?.removeAllListeners(); } catch { /* ignore */ }
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
    try { state.client?.removeAllListeners(); } catch { /* ignore */ }
    if (state.launched) {
      await state.client?.logout().catch(() => {});
      await state.client?.destroy().catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
    }
    clients.delete(clientId);
    _clearSessionLock(clientId);
  }
  _createClient(clientId, doc?.label || '', doc?.phone || '', 0);
}

async function updateAccount(clientId, { label, phone } = {}) {
  const WhatsAppAccount = require('../models/WhatsAppAccount');
  const state = clients.get(clientId);
  if (!state) throw new Error('Account not found');
  const update = {};
  if (label !== undefined) { update.label = label; state.label = label; }
  if (phone !== undefined) { update.phone  = phone;  state.phone  = phone;  }
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
      err.message.includes('getChat') || err.message.includes('Target closed') ||
      err.message.includes('Protocol error') || err.message.includes('Session closed') ||
      err.name === 'TargetCloseError'
    );
    if (isCrash) {
      state.status = 'disconnected'; state.qr = null;
      logger.warn(`[WA:${clientId}] client died during send — restarting in 5s`);
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
  await VirtualNumber.updateOne({ _id: virtualNumberId }, { $set: { whatsappClientId: clientId, hasWhatsApp: false } });
  logger.info(`[WA] Provisioned WhatsApp session for virtual number ${phoneLabel}`, { clientId });
  return clientId;
}

async function sendMessage(phone, message, mediaPath) {
  const ready = Array.from(clients.values()).filter((s) => s.status === 'ready' && s.client);
  if (ready.length === 0) throw new Error('No WhatsApp account connected. Please scan the QR code.');
  const idx    = rrIndex % ready.length;
  rrIndex      = (rrIndex + 1) % Math.max(ready.length, 1);
  const chatId = phone.replace(/\D/g, '') + '@c.us';
  const state  = ready[idx];
  try {
    if (mediaPath && fs.existsSync(mediaPath)) {
      const media = MessageMedia.fromFilePath(mediaPath);
      await state.client.sendMessage(chatId, media, { caption: message || '' });
    } else {
      await state.client.sendMessage(chatId, message);
    }
  } catch (err) {
    const isCrash = err.message && (
      err.message.includes('getChat') || err.message.includes('Target closed') ||
      err.message.includes('Protocol error') || err.message.includes('Session closed') ||
      err.name === 'TargetCloseError'
    );
    if (isCrash) {
      state.status = 'disconnected'; state.qr = null;
      logger.warn(`[WA:${state.clientId}] client died during send — restarting in 5s`);
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
