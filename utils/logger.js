const { NODE_ENV } = require('../config/env');

function log(level, ...args) {
  const timestamp = new Date().toISOString();
  const msg = [`[${timestamp}]`, `[${level}]`, ...args].join(' ');
  if (level === 'error') console.error(msg);
  else console.log(msg);
}

module.exports = {
  info: (...args) => log('INFO', ...args),
  warn: (...args) => log('WARN', ...args),
  error: (...args) => log('ERROR', ...args),
  debug: (...args) => NODE_ENV === 'development' && log('DEBUG', ...args),
};
