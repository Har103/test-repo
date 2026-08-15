'use strict';
// Full browser E2E for the v2 UI, driving real Edge headless via CDP:
// login -> boards grid -> new board -> realtime column from Node (SSE)
// -> create card via UI -> card modal (comment, checklist, label, due date,
// description, attachment upload) -> transport switch to WS -> realtime via
// WS -> cleanup.
const { execFile } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://localhost/dockerup/public';
const PORT = 9333;
const DIR = 'C:\\Users\\Haris\\AppData\\Local\\Temp\\opencode\\cdp-profile';

let cookie = '';

const httpGet = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => resolve(data));
  }).on('error', reject);
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

const api = async (method, path, body) => {
  const opts = { method, headers: { cookie } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(BASE + path, opts);
  const sc = res.headers.get('set-cookie');
  if (sc) { const s = sc.match(/dockup_session=[^;,]+/g); if (s) cookie = s[s.length - 1]; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data.error || ''}`);
  return data;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const ok = (name, cond) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'} ${name}`);
  if (!cond) fail++;
};
const poll = async (fn, timeout = 10000, interval = 250) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(interval);
  }
  return null;
};

(async () => {
  await api('POST', '/api/auth/login', { username: 'demo', password: 'demo123' });
  let testBoardId = null;

  const browser = execFile(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    `--user-data-dir=${DIR}`, `--remote-debugging-port=${PORT}`, 'about:blank',
  ], { windowsHide: true });

  let target = null;
  for (let i = 0; i < 40; i++) {
    try {
      const list = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`));
      if (list.length) { target = list[0]; break; }
    } catch { /* booting */ }
    await sleep(250);
  }
  if (!target) { console.log('CDP: no target'); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  const exceptions = [];
  const consoleErrors = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      exceptions.push((msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text).slice(0, 300));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value || a.description || '').join(' '));
    }
  });

  await cdpCall(ws, 1, 'Page.enable');
  await cdpCall(ws, 2, 'Runtime.enable');

  const evalJs = async (expr) => {
    const r = await cdpCall(ws, Math.floor(Math.random() * 1e9), 'Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.result?.exceptionDetails) throw new Error('JS: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
    return r.result?.result?.value;
  };

  // ------------------------- auth screen --------------------------
  await cdpCall(ws, 3, 'Page.navigate', { url: BASE + '/' });
  await sleep(4000);
  const loggedIn = await evalJs(`document.getElementById('app').classList.contains('hidden') === false`);
  if (!loggedIn) {
    ok('auth screen visible', await evalJs(`!document.getElementById('auth-screen').classList.contains('hidden')`));
    await evalJs(`(() => {
      const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); };
      set('login-user', 'demo'); set('login-pass', 'demo123');
      document.getElementById('login-form').dispatchEvent(new Event('submit', {bubbles:true, cancelable:true}));
      return true;
    })()`);
  } else {
    console.log('  (already logged in from previous run)');
  }
  ok('app visible', await poll(() => evalJs(`!document.getElementById('app').classList.contains('hidden')`)));
  ok('username shown', await evalJs(`document.getElementById('username').textContent === 'demo'`));
  ok('boards grid has tiles', await poll(() => evalJs(`document.querySelectorAll('.board-tile').length >= 1`), 8000));

  // ----------------------- create test board ----------------------
  await evalJs(`(() => { window.__esUrl = ''; const _add = EventSource.prototype.addEventListener; EventSource.prototype.addEventListener = function(...args) { window.__esUrl = this.url; return _add.apply(this, args); }; return true; })()`);
  await evalJs(`document.getElementById('btn-new-board').click(); true`);
  await sleep(400);
  await evalJs(`(() => {
    const el = document.getElementById('board-modal-title');
    el.value = 'E2E Board';
    el.dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('btn-create-board').click();
    return true;
  })()`);
  ok('new board opens', await poll(() => evalJs(`!document.getElementById('view-board').classList.contains('hidden')`), 8000));
  ok('board title in crumb', (await evalJs(`document.getElementById('board-title').textContent`)) === 'E2E Board');

  const boards = await api('GET', '/api/boards');
  testBoardId = boards.boards.find((b) => b.title === 'E2E Board')?.id;

  // ------------------------- realtime column ----------------------
  const transportLabel = await evalJs(`document.getElementById('conn-label').textContent`);
  console.log('  [diag] transport label:', transportLabel);
  await api('POST', `/api/boards/${testBoardId}/columns`, { title: 'To Do' });
  ok('column created by Node arrives via SSE', await poll(() => evalJs(`document.querySelectorAll('.column').length >= 1`), 8000));
  if ((await evalJs(`document.querySelectorAll('.column').length`)) === 0) {
    console.log('  [diag] feed items:', await evalJs(`document.getElementById('feed-list').children.length`));
    console.log('  [diag] es url:', await evalJs(`window.__esUrl`));
    console.log('  [diag] exceptions so far:', JSON.stringify(exceptions));
  }

  // ------------------------- create a card via UI -----------------
  await evalJs(`(() => {
    window.__reqs = [];
    const _f = window.fetch;
    window.fetch = (...a) => {
      window.__reqs.push(String(a[0]));
      return _f.apply(window, a).then(async (r) => {
        window.__resp = [String(a[0]), r.status, (await r.clone().text().catch(() => ''))];
        return r;
      });
    };
    window.prompt = () => 'E2E card';
    return true;
  })()`);
  await evalJs(`document.querySelector('.add-card').click(); true`);
  await sleep(3000);
  ok('card created via UI', await poll(() => evalJs(`document.querySelectorAll('.card').length >= 1`), 8000));
  if ((await evalJs(`document.querySelectorAll('.card').length`)) === 0) {
    console.log('  [diag] requests:', await evalJs(`JSON.stringify(window.__reqs)`));
    console.log('  [diag] last resp:', await evalJs(`JSON.stringify(window.__resp)`));
    console.log('  [diag] banner:', await evalJs(`document.getElementById('banner').textContent`));
    console.log('  [diag] feed items:', await evalJs(`document.getElementById('feed-list').children.length`));
    console.log('  [diag] exceptions:', JSON.stringify(exceptions));
    const snap = await api('GET', `/api/boards/${testBoardId}`);
    console.log('  [diag] server columns:', JSON.stringify(snap.columns.map((c) => [c.title, c.cards.length])));
  }
  ok('card titled from prompt', (await evalJs(`document.querySelector('.card-title').textContent`)) === 'E2E card');

  // ------------------------- realtime: Node adds column -----------
  await api('POST', `/api/boards/${testBoardId}/columns`, { title: 'Realtime Col' });
  ok('Node-added column arrives via SSE', await poll(() => evalJs(`[...document.querySelectorAll('.col-title')].some(el => el.textContent === 'Realtime Col')`), 8000));

  // ------------------------- open card modal ----------------------
  await evalJs(`document.querySelector('.card').click(); true`);
  ok('card modal opens', await poll(() => evalJs(`document.getElementById('card-modal').open`)));
  ok('modal title matches', (await evalJs(`document.getElementById('cm-title').value`)) === 'E2E card');

  // comment
  await evalJs(`document.getElementById('cm-comment-input').innerHTML = 'hello <b>from</b> e2e'; true`);
  await evalJs(`document.getElementById('cm-save-comment').click(); true`);
  ok('comment posted', await poll(() => evalJs(`document.querySelectorAll('.comment').length >= 1`)));
  ok('comment rendered', (await evalJs(`document.querySelector('.comment-body').innerHTML`)).includes('<b>from</b>'));

  // checklist
  await evalJs(`(() => {
    const el = document.getElementById('cm-checklist-input');
    el.value = 'first item';
    document.getElementById('cm-checklist-form').dispatchEvent(new Event('submit', {bubbles:true, cancelable:true}));
    return true;
  })()`);
  ok('checklist item added', await poll(() => evalJs(`document.querySelectorAll('.cl-item').length >= 1`)));
  await evalJs(`document.querySelector('.cl-item input[type=checkbox]').click(); true`);
  ok('checklist checks + badge appears', await poll(() => evalJs(`document.querySelector('.cl-item').classList.contains('checked') && document.querySelectorAll('.badge').length >= 1`)));

  // label
  await evalJs(`window.prompt = () => 'bug'; true`);
  await evalJs(`document.getElementById('cm-add-label').click(); true`);
  ok('label chip appears', await poll(() => evalJs(`[...document.querySelectorAll('#cm-labels .lbl')].some(el => el.textContent === 'bug')`)));

  // due date
  await evalJs(`(() => { const el = document.getElementById('cm-due'); el.value = '2026-12-31'; el.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
  await sleep(600);
  await evalJs(`document.getElementById('card-modal').close(); true`);
  ok('due date badge on card', (await evalJs(`[...document.querySelectorAll('.badge')].some(el => el.textContent.includes('2026-12-31'))`)));

  // description with rich toolbar
  await evalJs(`document.querySelector('.card').click(); true`);
  await sleep(400);
  await evalJs(`document.getElementById('cm-desc').innerHTML = '<p>rich <b>desc</b></p>'; true`);
  await evalJs(`document.getElementById('cm-save-desc').click(); true`);
  ok('description saved', await poll(() => evalJs(`document.getElementById('cm-desc-status').textContent.includes('saved')`)));
  const snapshot = await api('GET', `/api/boards/${testBoardId}`);
  const cardId = snapshot.columns[0].cards[0].id;
  const detail = await api('GET', `/api/cards/${cardId}`);
  ok('description stored sanitized', /<p>rich <b>desc<\/b><\/p>/.test(detail.card.description_html));

  // attachment upload via DOM.setFileInputFiles
  const pngPath = path.join(__dirname, 'e2e-pixel.png');
  fs.writeFileSync(pngPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const { result } = await cdpCall(ws, 99, 'DOM.getDocument', { depth: -1 });
  const nodeId = await cdpCall(ws, 100, 'DOM.querySelector', { nodeId: result.root.nodeId, selector: '#cm-attach-file' });
  await cdpCall(ws, 101, 'DOM.setFileInputFiles', { nodeId: nodeId.result.nodeId, files: [pngPath] });
  ok('attachment uploaded + preview', await poll(() => evalJs(`document.querySelectorAll('.attachment img').length >= 1`), 8000));
  fs.unlinkSync(pngPath);

  // --------------------- switch transport to WS -------------------
  await evalJs(`document.getElementById('card-modal').close(); true`);
  await evalJs(`localStorage.setItem('dockup.transport', 'ws'); location.reload(); true`);
  await sleep(5000);
  await evalJs(`[...document.querySelectorAll('.board-tile')].find(t => t.textContent.includes('E2E Board')).click(); true`);
  await poll(() => evalJs(`!document.getElementById('view-board').classList.contains('hidden')`));
  ok('WS connected', await poll(() => evalJs(`/WebSocket.*connected/.test(document.getElementById('conn-label').textContent)`), 8000));

  await api('POST', `/api/boards/${testBoardId}/columns`, { title: 'Ws Col' });
  ok('Node-added column arrives via WS', await poll(() => evalJs(`[...document.querySelectorAll('.col-title')].some(el => el.textContent === 'Ws Col')`), 8000));

  // --------------------------- cleanup ----------------------------
  if (testBoardId) {
    await api('DELETE', `/api/boards/${testBoardId}`);
    await sleep(500);
  }

  console.log('exceptions:', JSON.stringify(exceptions));
  console.log('console errors:', JSON.stringify(consoleErrors));
  browser.kill();
  console.log(fail === 0 && exceptions.length === 0 ? '\n== BROWSER E2E PASSED ==' : `\n== BROWSER E2E FAILED (${fail} steps, ${exceptions.length} exceptions) ==`);
  process.exit(fail || exceptions.length ? 1 : 0);
})().catch((e) => { console.log('HARNESS FAIL:', e.message); process.exit(1); });
