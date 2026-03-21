const express = require('express');
const helmet = require('helmet');
const { API_PREFIX, NODE_ENV } = require('./config/env');
const { auth } = require('./middleware/auth');
const { rateLimit } = require('./middleware/rateLimit');

const authRoutes        = require('./routes/auth');
const usersRoutes       = require('./routes/users');
const creditsRoutes     = require('./routes/credits');
const campaignsRoutes   = require('./routes/campaigns');
const numbersRoutes     = require('./routes/numbers');
const analyticsRoutes   = require('./routes/analytics');
const settingsRoutes    = require('./routes/settings');
const demoRequestsRoutes = require('./routes/demoRequests');
const aiRoutes          = require('./routes/ai');
const whatsappRoutes    = require('./routes/whatsapp');
const apiKeysRoutes     = require('./routes/apiKeys');

const app = express();

// ── CORS — must be first, before helmet and all routes ────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400'); // cache preflight for 24h
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(helmet({ contentSecurityPolicy: NODE_ENV === 'production', crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Optional request logging
if (process.env.DEBUG_REQUESTS === '1') {
  app.use((req, res, next) => {
    console.log('[REQ]', new Date().toISOString(), req.method, req.originalUrl);
    next();
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.use(`${API_PREFIX}/auth`,          authRoutes);
app.use(`${API_PREFIX}/users`,         auth, rateLimit, usersRoutes);
app.use(`${API_PREFIX}/credits`,       auth, rateLimit, creditsRoutes);
app.use(`${API_PREFIX}/campaigns`,     auth, rateLimit, campaignsRoutes);
app.use(`${API_PREFIX}/numbers`,       auth, rateLimit, numbersRoutes);
app.use(`${API_PREFIX}/analytics`,     auth, rateLimit, analyticsRoutes);
app.use(`${API_PREFIX}/settings`,      auth, rateLimit, settingsRoutes);
app.use(`${API_PREFIX}/demo-requests`, auth, rateLimit, demoRequestsRoutes);
app.use(`${API_PREFIX}/ai`,            auth, rateLimit, aiRoutes);
app.use(`${API_PREFIX}/whatsapp`,      whatsappRoutes);
app.use(`${API_PREFIX}/api-keys`,      auth, rateLimit, apiKeysRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: err.message || 'Server error' });
});

module.exports = app;
