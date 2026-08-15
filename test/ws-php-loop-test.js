'use strict';
// Connects a WS client, then triggers real PHP API mutations and verifies
// the events arrive over WebSocket (PHP -> Rust -> browser path).
const net = require('net');
const crypto = require('crypto');
const PORT = 9001;

function encodeFrame(payload) {
  const buf = Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  const len = buf.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  const masked = Buffer.from(buf);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function parseIncoming(buf, out) {
  let idx = 0;
  while (buf.length - idx >= 2) {
    const opcode = buf[idx] & 0x0f;
    let len = buf[idx + 1] & 0x7f;
    let off = idx + 2;
    if (len === 126) { if (buf.length - off < 2) break; len = buf.readUInt16BE(off); off += 2; }
    if (buf.length - off < len) break;
    out.push({ opcode, payload: buf.subarray(off, off + len).toString('utf8') });
    idx = off + len;
  }
  return idx;
}

(async () => {
  const key = crypto.randomBytes(16).toString('base64');
  const sock = net.connect(PORT, '127.0.0.1', () => {
    sock.write([
      'GET / HTTP/1.1', 'Host: 127.0.0.1:' + PORT,
      'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '', '',
    ].join('\r\n'));
  });

  let buf = Buffer.alloc(0), hs = false;
  const events = [];
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!hs) {
      const s = buf.toString('utf8');
      const end = s.indexOf('\r\n\r\n');
      if (end === -1) return;
      if (!s.includes('101')) { console.log('handshake failed'); process.exit(1); }
      hs = true;
      buf = buf.subarray(end + 4);
      if (buf.length === 0) return;
    }
    const msgs = [];
    buf = buf.subarray(parseIncoming(buf, msgs));
    for (const m of msgs) if (m.opcode === 0x1) events.push(JSON.parse(m.payload));
  });

  await new Promise((r) => setTimeout(r, 400));
  if (!hs) { console.log('handshake timeout'); process.exit(1); }
  console.log('ws connected; waiting for PHP-generated events…');

  const req = (method, path, body) => fetch('http://127.0.0.1:8080' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

  const col = await req('POST', '/api/columns', { title: 'WS test col', color: '#a855f7' });
  console.log('created column', col.column.id);
  const card = await req('POST', '/api/cards', { columnId: col.column.id, title: 'live card', note: 'from node' });
  console.log('created card', card.card.id);
  await req('POST', `/api/cards/${card.card.id}/move`, { columnId: col.column.id, position: 0 });
  await req('PUT', `/api/cards/${card.card.id}`, { title: 'renamed', note: '' });
  const bad = await req('PUT', `/api/cards/99999`, { title: 'nope' });
  console.log('renamed (update ok):', bad.ok === undefined);
  const del = await req('DELETE', `/api/cards/${card.card.id}`);
  console.log('deleted card:', del.ok);

  await new Promise((r) => setTimeout(r, 800));
  const types = events.map((e) => e.type);
  console.log('received over WS:', JSON.stringify(types));
  const need = ['column.created', 'card.created', 'card.updated', 'card.moved', 'card.deleted'];
  const ok = need.every((t) => types.includes(t));
  console.log(ok ? 'PHP->Rust->WS: PASS' : 'PHP->Rust->WS: FAIL');
  sock.end();
  process.exit(ok ? 0 : 1);
})();
