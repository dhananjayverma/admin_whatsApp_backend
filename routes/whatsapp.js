const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const { auth } = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');
const waClient = require('../services/whatsappClientService');
const { JWT_SECRET } = require('../config/env');

const router = express.Router();

const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now().toString(36) + Math.random().toString(36).slice(2) + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 16 * 1024 * 1024 } });

const activeSendJobs = new Map();

// ── SSE auth — token passed as ?token= query param (EventSource can't set headers)
function sseAuth(req, res, next) {
  const token = req.query.token;
  if (!token) return res.status(401).end();
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.sseUser = { id: decoded.userId, role: decoded.role };
    next();
  } catch {
    res.status(401).end();
  }
}

function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();
}

function sseSend(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Admin SSE — real-time push for all admin accounts
router.get('/events', sseAuth, (req, res) => {
  if (req.sseUser.role !== 'admin') return res.status(403).end();

  sseHeaders(res);

  // Send current snapshot immediately
  const accounts = waClient.getAllStatus().filter((a) => !a.clientId.startsWith('user_'));
  sseSend(res, { type: 'snapshot', accounts });

  // Keep-alive ping every 25s (proxies drop idle SSE after 30s)
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);

  const onUpdate = ({ clientId }) => {
    if (clientId.startsWith('user_')) return;
    const accounts = waClient.getAllStatus().filter((a) => !a.clientId.startsWith('user_'));
    sseSend(res, { type: 'snapshot', accounts });
  };

  waClient.waEvents.on('update', onUpdate);

  req.on('close', () => {
    clearInterval(ping);
    waClient.waEvents.off('update', onUpdate);
  });
});

// ── Client SSE — real-time push for own session
router.get('/my/events', sseAuth, (req, res) => {
  const clientId = `user_${req.sseUser.id}`;

  sseHeaders(res);

  const getSession = () => {
    const all = waClient.getAllStatus();
    return all.find((a) => a.clientId === clientId) || null;
  };

  sseSend(res, { type: 'session', session: getSession() });

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);

  const onUpdate = ({ clientId: updatedId }) => {
    if (updatedId !== clientId) return;
    sseSend(res, { type: 'session', session: getSession() });
  };

  waClient.waEvents.on('update', onUpdate);

  req.on('close', () => {
    clearInterval(ping);
    waClient.waEvents.off('update', onUpdate);
  });
});

// ── Account management ────────────────────────────────────────────────────────

router.get('/accounts', auth, allowRoles('admin'), (req, res) => {
  const accounts = waClient.getAllStatus().filter((a) => !a.clientId.startsWith('user_'));
  res.json({ accounts });
});

router.get('/status', auth, (req, res) => {
  const adminAccounts = waClient.getAllStatus().filter((a) => !a.clientId.startsWith('user_'));
  const first = adminAccounts[0];
  res.json(first ? { status: first.status, qr: first.qr } : { status: 'loading', qr: null });
});

router.post('/accounts', auth, allowRoles('admin'), async (req, res) => {
  try {
    const { label } = req.body || {};
    const clientId = await waClient.addAccount(label);
    res.json({ clientId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/accounts/:clientId/reconnect', auth, allowRoles('admin'), async (req, res) => {
  try {
    await waClient.reconnectAccount(req.params.clientId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: request pairing code instead of QR
router.post('/accounts/:clientId/pairing-code', auth, allowRoles('admin'), async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ message: 'Phone number required' });
    const code = await waClient.requestPairingCode(req.params.clientId, phone);
    res.json({ code });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.patch('/accounts/:clientId', auth, allowRoles('admin'), async (req, res) => {
  try {
    await waClient.updateAccount(req.params.clientId, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete('/accounts/:clientId', auth, allowRoles('admin'), async (req, res) => {
  try {
    await waClient.removeAccount(req.params.clientId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Client self-managed WhatsApp session ─────────────────────────────────────

router.get('/my', auth, (req, res) => {
  const clientId = `user_${req.user.id}`;
  const session = waClient.getAllStatus().find((a) => a.clientId === clientId) || null;
  res.json({ session });
});

router.post('/my/connect', auth, async (req, res) => {
  try {
    const clientId = `user_${req.user.id}`;
    const label = `Client: ${req.user.email}`;
    const WhatsAppAccount = require('../models/WhatsAppAccount');
    await WhatsAppAccount.updateOne(
      { clientId },
      { $setOnInsert: { clientId, label, phone: '' } },
      { upsert: true }
    );
    if (!waClient.getAllStatus().find((a) => a.clientId === clientId)) {
      waClient._startClientForUser(clientId, label);
    }
    res.json({ clientId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/my/reconnect', auth, async (req, res) => {
  try {
    await waClient.reconnectAccount(`user_${req.user.id}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Client: request pairing code for own session
router.post('/my/pairing-code', auth, async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ message: 'Phone number required' });
    const code = await waClient.requestPairingCode(`user_${req.user.id}`, phone);
    res.json({ code });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete('/my', auth, async (req, res) => {
  try {
    await waClient.removeAccount(`user_${req.user.id}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/logout', auth, allowRoles('admin'), async (req, res) => {
  try {
    const { clientId } = req.body || {};
    if (clientId) await waClient.reconnectAccount(clientId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── File upload ───────────────────────────────────────────────────────────────

router.post('/upload', auth, allowRoles('admin'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
  res.json({
    fileId: req.file.filename,
    originalName: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
  });
});

router.delete('/upload/:fileId', auth, allowRoles('admin'), (req, res) => {
  const filePath = path.join(uploadsDir, req.params.fileId);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// ── Bulk send ─────────────────────────────────────────────────────────────────

router.post('/send-bulk', auth, allowRoles('admin'), async (req, res) => {
  const { numbers, message, delayMs, fileId } = req.body || {};
  const msgDelay = typeof delayMs === 'number' && delayMs >= 0 ? delayMs : 5000;
  const msgText = String(message || '').trim();
  const mediaPath = fileId ? path.join(uploadsDir, fileId) : null;

  if (!Array.isArray(numbers) || numbers.length === 0)
    return res.status(400).json({ message: 'No numbers provided' });
  if (!msgText && !mediaPath)
    return res.status(400).json({ message: 'Message or media file is required' });
  if (mediaPath && !fs.existsSync(mediaPath))
    return res.status(400).json({ message: 'Uploaded file not found. Please re-upload.' });

  const phones = numbers.map((n) => String(n).replace(/\D/g, '')).filter((n) => n.length >= 10 && n.length <= 15);
  if (phones.length === 0) return res.status(400).json({ message: 'No valid phone numbers found' });

  const ready = waClient.getAllStatus().filter((a) => a.status === 'ready');
  if (ready.length === 0)
    return res.status(400).json({ message: 'No WhatsApp account connected. Scan QR first.' });

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const job = { id: jobId, total: phones.length, sent: 0, failed: 0, status: 'running', errors: [] };
  activeSendJobs.set(jobId, job);

  (async () => {
    for (let i = 0; i < phones.length; i++) {
      if (job.status === 'cancelled') break;
      try {
        await waClient.sendMessage(phones[i], msgText, mediaPath);
        job.sent++;
      } catch (err) {
        job.failed++;
        if (job.errors.length < 50) {
          let msg = err.message || 'Unknown error';
          if (msg.includes('No LID for user') || msg.includes('not a contact')) msg = 'Not on WhatsApp or missing country code';
          if (msg.includes('invalid wid')) msg = 'Invalid number format';
          job.errors.push({ phone: phones[i], error: msg });
        }
      }
      if (i < phones.length - 1) await new Promise((r) => setTimeout(r, msgDelay));
    }
    job.status = 'done';
    if (mediaPath && fs.existsSync(mediaPath)) {
      setTimeout(() => { try { fs.unlinkSync(mediaPath); } catch {} }, 5000);
    }
    setTimeout(() => activeSendJobs.delete(jobId), 30 * 60 * 1000);
  })();

  res.json({ jobId, total: phones.length });
});

router.get('/send-bulk/:jobId', auth, allowRoles('admin'), (req, res) => {
  const job = activeSendJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ message: 'Job not found or expired' });
  res.json(job);
});

router.post('/send-bulk/:jobId/cancel', auth, allowRoles('admin'), (req, res) => {
  const job = activeSendJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ message: 'Job not found' });
  job.status = 'cancelled';
  res.json({ ok: true });
});

module.exports = router;
