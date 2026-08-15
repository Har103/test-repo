'use strict';
// Probe: how long until SSE headers + first data arrive on each server?
const http = require('http');

function probe(url, label) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.get(url, { headers: { Accept: 'text/event-stream' } });
    let gotHeader = false;
    const timer = setTimeout(() => {
      console.log(`${label}: NO HEADERS within 6s (hang)`);
      req.destroy();
      resolve(false);
    }, 6000);
    req.on('response', (res) => {
      gotHeader = true;
      console.log(`${label}: headers after ${Date.now() - t0}ms (${res.statusCode} ${res.headers['content-type']})`);
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString();
        if (buf.includes('data:')) {
          console.log(`${label}: first data after ${Date.now() - t0}ms`);
          clearTimeout(timer);
          res.destroy();
          resolve(true);
        }
      });
    });
    req.on('error', () => { if (!gotHeader) { clearTimeout(timer); console.log(`${label}: error, no headers`); resolve(false); } });
  });
}

(async () => {
  const a = await probe('http://localhost/dockerup/public/api/events', 'Apache');
  const b = await probe('http://127.0.0.1:8080/api/events', 'php-S  ');
  process.exit(a && b ? 0 : 1);
})();
