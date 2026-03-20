const { connectDB } = require('./config/db');
const app = require('./app');
const { PORT } = require('./config/env');

// Puppeteer/whatsapp-web.js throws TargetCloseError as unhandled rejections
// when the browser tab closes mid-operation. Catch them here to prevent crash.
process.on('unhandledRejection', (err) => {
  if (err && (err.name === 'TargetCloseError' || err.name === 'ProtocolError' ||
      (err.message && err.message.includes('Target closed')))) {
    // Intentionally ignored — whatsapp-web.js auto-restarts via disconnected event
    return;
  }
  console.error('[unhandledRejection]', err);
});

process.on('uncaughtException', (err) => {
  if (err && (err.name === 'TargetCloseError' || err.name === 'ProtocolError' ||
      (err.message && err.message.includes('Target closed')))) {
    return;
  }
  console.error('[uncaughtException]', err);
  process.exit(1);
});

async function start() {
  await connectDB();

  // Initialize all WhatsApp accounts from DB
  const waClient = require('./services/whatsappClientService');
  await waClient.initAll();

  // Start Bull queue worker in the same process
  const { initWorker } = require('./workers/whatsappWorker');
  initWorker();

  app.listen(PORT, () => {
    console.log(`API listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
