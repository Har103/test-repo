'use strict';
// SSE test: open /api/events on server A (8080), mutate via server B (8081),
// confirm events stream over SSE. (Two servers because php -S is
// single-threaded; Apache handles SSE + API on one server natively.)
const http = require('http');

const events = [];
let buf = '';

function drain(line) {
  if (line.startsWith('data:')) {
    try { events.push(JSON.parse(line.slice(5).trim())); } catch {}
  }
}

const req = http.get('http://127.0.0.1:8080/api/events', {
  headers: { Accept: 'text/event-stream' },
});
req.on('response', (res) => {
  console.log('SSE status:', res.statusCode, res.headers['content-type']);
  res.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      drain(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });
});
req.on('error', (e) => { console.log('SSE error:', e.message); process.exit(1); });

const mutate = (method, path, body) =>
  fetch('http://127.0.0.1:8081' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

(async () => {
  await new Promise((r) => setTimeout(r, 600));
  const col = await mutate('POST', '/api/columns', { title: 'SSE test col' });
  console.log('mutated on B -> column', col.column.id);
  await mutate('POST', '/api/cards', { columnId: col.column.id, title: 'sse card' });
  await new Promise((r) => setTimeout(r, 1200));

  const types = events.map((e) => e.type);
  console.log('received over SSE:', JSON.stringify(types));
  const ok = types.includes('column.created') && types.includes('card.created');
  console.log(ok ? 'PHP SSE: PASS' : 'PHP SSE: FAIL');
  process.exit(ok ? 0 : 1);
})();
