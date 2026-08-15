'use strict';
// End-to-end test: two raw WS clients + broadcast fan-out.
const net = require('net');
const crypto = require('crypto');

const PORT = 9001;

function encodeFrame(payload) {
  const buf = Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  const len = buf.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else if (len <= 0xffff) {
    header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
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
    else if (len === 127) { if (buf.length - off < 8) break; len = Number(buf.readBigUInt64BE(off)); off += 8; }
    if (buf.length - off < len) break;
    out.push({ opcode, payload: buf.subarray(off, off + len).toString('utf8') });
    idx = off + len;
  }
  return idx;
}

function wsClient(name) {
  return new Promise((resolve, reject) => {
    const c = { name, messages: [], buf: Buffer.alloc(0), handshaken: false };
    const key = crypto.randomBytes(16).toString('base64');
    c.sock = net.connect(PORT, '127.0.0.1', () => {
      const upgrade = [
        'GET / HTTP/1.1', 'Host: 127.0.0.1:' + PORT,
        'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '', '',
      ].join('\r\n');
      c.sock.write(upgrade);
    });
    c.sock.on('data', (chunk) => {
      c.buf = Buffer.concat([c.buf, chunk]);
      if (!c.handshaken) {
        const s = c.buf.toString('utf8');
        const end = s.indexOf('\r\n\r\n');
        if (end === -1) return;
        if (!s.includes('101')) { reject(new Error(`${name}: handshake failed`)); return; }
        c.handshaken = true;
        c.buf = c.buf.subarray(end + 4);
        resolve(c);
        if (c.buf.length === 0) return;
      }
      const msgs = [];
      c.buf = c.buf.subarray(parseIncoming(c.buf, msgs));
      for (const m of msgs) {
        if (m.opcode === 0x1) c.messages.push(JSON.parse(m.payload));
      }
      if (c.messages.length >= 1) resolve(c);
    });
    c.sock.on('error', (e) => reject(new Error(`${name}: ${e.message}`)));
  });
}

(async () => {
  try {
    const [a, b] = await Promise.all([wsClient('A'), wsClient('B')]);
    console.log('both clients connected');

    // Heartbeat ping (private pong, not broadcast).
    a.sock.write(encodeFrame(JSON.stringify({ type: '__ping' })));
    await new Promise((r) => setTimeout(r, 500));
    const gotPong = a.messages.some((m) => m.type === '__pong');
    console.log(`A received private pong: ${gotPong}`);
    if (!gotPong) process.exit(1);

    // Broadcast via HTTP (exactly what PHP does).
    const payload = JSON.stringify({ type: 'card.created', data: { id: 42, title: 'test card' }, ts: Date.now() });
    await new Promise((r) => {
      const http = net.connect(PORT, '127.0.0.1', () => {
        http.write([
          'POST /broadcast HTTP/1.1', 'Host: 127.0.0.1:' + PORT,
          'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(payload)}`,
          'Connection: close', '', '', payload,
        ].join('\r\n'));
      });
      let resp = '';
      http.on('data', (d) => { resp += d; });
      http.on('close', () => { console.log('broadcast http status:', resp.split('\r\n')[0]); r(); });
    });

    await new Promise((r) => setTimeout(r, 700));
    const aGot = a.messages.some((m) => m.type === 'card.created');
    const bGot = b.messages.some((m) => m.type === 'card.created');
    console.log(`A got broadcast: ${aGot} | B got broadcast: ${bGot}`);

    a.sock.end(); b.sock.end();
    console.log(aGot && bGot ? 'E2E WS: PASS' : 'E2E WS: FAIL');
    process.exit(aGot && bGot ? 0 : 1);
  } catch (e) {
    console.log('E2E WS: FAIL ->', e.message);
    process.exit(1);
  }
})();
