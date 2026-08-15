'use strict';
// CDP harness: drives real Edge headless, captures exceptions + final DOM state.
const { execFile } = require('child_process');
const http = require('http');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PAGE = process.argv[2] || 'http://localhost/dockerup/public/';
const PORT = 9333;
const DIR = 'C:\\Users\\Haris\\AppData\\Local\\Temp\\opencode\\cdp-profile';

const httpGet = (url) =>
  new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
const httpPut = (url) =>
  new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'PUT' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });

function cdpCall(ws, id, method, params = {}) {
  return new Promise((resolve) => {
    const handler = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) {
        ws.removeEventListener('message', handler);
        resolve(msg);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

(async () => {
  const browser = execFile(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    `--user-data-dir=${DIR}`, `--remote-debugging-port=${PORT}`, 'about:blank',
  ], { windowsHide: true });

  // wait for CDP
  let target = null;
  for (let i = 0; i < 40; i++) {
    try {
      const list = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`));
      if (list.length) { target = list[0]; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!target) { console.log('CDP: no target'); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  const exceptions = [];
  const logs = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      exceptions.push(msg.params.exceptionDetails.text + ' :: ' +
        (msg.params.exceptionDetails.exception?.description || '').slice(0, 300));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      logs.push(msg.params.args.map((a) => a.value || a.description || '').join(' '));
    }
  });

  await cdpCall(ws, 1, 'Page.enable');
  await cdpCall(ws, 2, 'Runtime.enable');
  await cdpCall(ws, 3, 'Page.navigate', { url: PAGE });

  await new Promise((r) => setTimeout(r, 9000));

  const evalJs = async (expr) => {
    const r = await cdpCall(ws, Math.floor(Math.random() * 1e6), 'Runtime.evaluate', {
      expression: expr, returnByValue: true,
    });
    return r.result?.result?.value;
  };

  console.log('label:', await evalJs(`document.getElementById('conn-label').textContent`));
  console.log('dot  :', await evalJs(`document.getElementById('conn-dot').className`));
  console.log('cols :', await evalJs(`document.querySelectorAll('.column').length`));
  console.log('banner:', await evalJs(`document.getElementById('banner').className`));
  console.log('board-empty hidden:', await evalJs(`document.getElementById('board-empty').hidden`));
  console.log('exceptions:', JSON.stringify(exceptions));
  console.log('console errors:', JSON.stringify(logs));

  // ---- switch to WebSocket transport and reload ----
  await evalJs(`localStorage.setItem('board.transport', 'ws'); location.reload(); true`);
  await new Promise((r) => setTimeout(r, 9000));
  console.log('--- after switch to WS ---');
  console.log('label:', await evalJs(`document.getElementById('conn-label').textContent`));
  console.log('dot  :', await evalJs(`document.getElementById('conn-dot').className`));
  console.log('cols :', await evalJs(`document.querySelectorAll('.column').length`));

  browser.kill();
  process.exit(exceptions.length ? 1 : 0);
})().catch((e) => { console.log('HARNESS FAIL:', e.message); process.exit(1); });
