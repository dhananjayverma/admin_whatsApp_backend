const { connectDB } = require('./config/db');
const app = require('./app');
const { PORT } = require('./config/env');

async function start() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`API listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
