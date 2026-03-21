const { connectDB } = require('./config/db');
const app = require('./app');
const { PORT } = require('./config/env');


function _isWWebJSNoise(err) {
  if (!err) return false;
  if (err.name === 'TargetCloseError' || err.name === 'ProtocolError') return true;
  const msg = err.message || '';
  return (
    msg.includes('Target closed') ||
    msg.includes('Execution context was destroyed') ||
    msg.includes('most likely because of a navigation')
  );
}

process.on('unhandledRejection', (err) => {
  if (_isWWebJSNoise(err)) return; // normal whatsapp-web.js page navigation noise
  console.error('[unhandledRejection]', err);
});

process.on('uncaughtException', (err) => {
  if (_isWWebJSNoise(err)) return;
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
