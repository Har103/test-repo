'use strict';
// Final test against Apache: one server, SSE stream + API mutations,
// plus a WebSocket client — all live at once, like two browser tabs.
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const BASE = 'http://localhost/dockerup/public';
const WS_PORT = 9001;
const sseEvents = [];
let wsEvents = [];
let buf = '';

// ---- SSE client ----
const sseReq = http.get(BASE + '/api/events', { headers: { Accept: 'text/event-stream' } });
sseReq.on('response', (res) => {
  res.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) {
        try { sseEvents.push(JSON.parse(line.slice(5).trim())); } catch {}
      }
    }
  });
});

// ---- WS client ----
function wsConnect() {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(WS_PORT, '127.0.0.1', () => {
      sock.write([
        'GET / HTTP/1.1', 'Host: 127.0.0.1:' + WS_PORT,
        'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '', '',
      ].join('\r\n'));
    });
    let b = Buffer.alloc(0), hs = false;
    sock.on('data', (chunk) => {
      b = Buffer.concat([b, chunk]);
      if (!hs) {
        const s = b.toString('utf8');
        const end = s.indexOf('\r\n\r\n');
        if (end === -1) return;
        if (!s.includes('101')) { reject(new Error('ws handshake failed')); return; }
        hs = true;
        b = b.subarray(end + 4);
        if (b.length === 0) return;
      }
      let idx = 0;
      while (b.length - idx >= 2) {
        const opcode = b[idx] & 0x0f;
        let len = b[idx + 1] & 0x7f;
        let off = idx + 2;
        if (len === 126) { if (b.length - off < 2) break; len = b.readUInt16BE(off); off += 2; }
        if (b.length - off < len) break;
        if (opcode === 0x1) wsEvents.push(JSON.parse(b.subarray(off, off + len).toString('utf8')));
        idx = off + len;
      }
      b = b.subarray(idx);
    });
    sock.on('connect', () => setTimeout(() => resolve(sock), 300));
    sock.on('error', reject);
  });
}

const api = (method, path, body) =>
  fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

(async () => {
  const ws = await wsConnect();
  console.log('ws connected');
  await new Promise((r) => setTimeout(r, 500));

  const col = await api('POST', '/api/columns', { title: 'apache e2e col' });
  const card = await api('POST', '/api/cards', { columnId: col.column.id, title: 'cross-transport card' });
  await api('POST', `/api/cards/${card.card.id}/move`, { columnId: col.column.id, position: 0 });
  await api('PUT', `/api/cards/${card.card.id}`, { title: 'seen on both transports' });
  await api('DELETE', `/api/cards/${card.card.id}`);

  await new Promise((r) => setTimeout(r, 1500));
  ws.end();

  const sseTypes = sseEvents.map((e) => e.type);
  const wsTypes = wsEvents.map((e) => e.type);
  console.log('SSE :', JSON.stringify(sseTypes.filter((t) => t.includes('.'))));
  console.log('WS  :', JSON.stringify(wsTypes));

  const want = ['column.created', 'card.created', 'card.moved', 'card.updated', 'card.deleted'];
  const sseOk = want.every((t) => sseTypes.includes(t));
  const wsOk = want.every((t) => wsTypes.includes(t));
  console.log(`Apache E2E: SSE ${sseOk ? 'PASS' : 'FAIL'} | WS ${wsOk ? 'PASS' : 'FAIL'}`);
  process.exit(sseOk && wsOk ? 0 : 1);
})().catch((e) => { console.log('E2E FAIL ->', e.message); process.exit(1); });
