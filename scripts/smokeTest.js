const http = require('http');

function get(path) {
  return new Promise((resolve) => {
    const opts = { host: '127.0.0.1', port: process.env.PORT || 5000, path, timeout: 5000 };
    const req = http.get(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
  });
}

(async () => {
  console.log('Running smoke tests against http://127.0.0.1:' + (process.env.PORT || 5000));
  const health = await get('/health');
  console.log('/health ->', health.error ? health.error : `${health.status}`);
})();
