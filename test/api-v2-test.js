'use strict';
/* API v2 smoke test: auth, boards, columns, cards, labels, checklist,
   comments, attachment upload (multipart), permissions, SSE. */

const BASE = process.env.APP_BASE || 'http://localhost/dockerup/public';
const fs = require('fs');
const path = require('path');

const UPLOAD_DIR_LOCAL = path.join(__dirname, '..', 'public', 'uploads');

let cookie = '';
const UNIQ = 't' + Date.now().toString(36);

function j(method, path, body) {
  const opts = { method, headers: { cookie }, redirect: 'manual' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return fetch(BASE + path, opts).then(async (res) => {
    const sc = res.headers.get('set-cookie');
    if (sc) {
      // session_regenerate_id() emits two Set-Cookie headers; the last one
      // is the live session id.
      const sessions = sc.match(/dockup_session=[^;,]+/g);
      if (sessions) cookie = sessions[sessions.length - 1];
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data.error || ''}`);
    return data;
  });
}

const step = (name, fn) => Promise.resolve().then(fn).then(() => console.log('  ok', name)).catch((e) => {
  console.error('  FAIL', name, '-', e.message);
  process.exitCode = 1;
});

(async () => {
  console.log(`== v2 API test (user ${UNIQ}) ==`);

  // Self-heal: a previously crashed run can leave throttle buckets locked
  // (the register bucket would 429 the very first register below). Reset
  // all auth-rate state before touching the API.
  require('child_process').execFileSync('C:/wamp64/bin/php/php8.4.0/php.exe', ['-r',
    `require ${JSON.stringify(path.join(__dirname, '..', 'src', 'db.php'))}; db()->exec('DELETE FROM login_attempts');`]);

  await step('health', async () => {
    const h = await j('GET', '/api/health');
    if (!h.ok || !h.wsUrl) throw new Error('bad health payload');
  });

  await step('register', async () => {
    const r = await j('POST', '/api/auth/register', { username: UNIQ, password: 'secret1' });
    if (!r.user || r.user.username !== UNIQ) throw new Error('no user returned');
  });

  await step('duplicate register rejected', async () => {
    try { await j('POST', '/api/auth/register', { username: UNIQ, password: 'secret1' }); throw new Error('expected 409'); }
    catch (e) { if (!/409/.test(e.message)) throw e; }
  });

  await step('login demo', async () => {
    const r = await j('POST', '/api/auth/login', { username: 'demo', password: 'demo123' });
    if (!r.user || r.user.username !== 'demo') throw new Error('demo login failed');
  });

  await step('logout + unauthorized boards -> 401', async () => {
    await j('POST', '/api/auth/logout');
    cookie = '';
    try { await j('GET', '/api/boards'); throw new Error('expected 401'); }
    catch (e) { if (!/401/.test(e.message)) throw e; }
  });

  await step('login fresh user', async () => {
    const r = await j('POST', '/api/auth/login', { username: UNIQ, password: 'secret1' });
    if (r.user.username !== UNIQ) throw new Error('wrong user');
  });

  await step('brute-force lockout (5 fails -> 429, then unlock)', async () => {
    const execFileSync = require('child_process').execFileSync;
    const rl = 'rl' + Date.now().toString(36);
    await j('POST', '/api/auth/register', { username: rl, password: 'secret1' });
    for (let i = 0; i < 5; i++) {
      try { await j('POST', '/api/auth/login', { username: rl, password: 'wrong' }); throw new Error('expected 401'); }
      catch (e) { if (!/401/.test(e.message)) throw e; }
    }
    try { await j('POST', '/api/auth/login', { username: rl, password: 'secret1' }); throw new Error('expected 429'); }
    catch (e) { if (!/429/.test(e.message)) throw e; }
    // The lockout buckets are anti-abuse state only — clear them so the
    // per-IP counter cannot accumulate toward the threshold across runs.
    execFileSync('C:/wamp64/bin/php/php8.4.0/php.exe', ['-r',
      `require ${JSON.stringify(path.join(__dirname, '..', 'src', 'db.php'))}; db()->exec('DELETE FROM login_attempts');`]);
    const r2 = await j('POST', '/api/auth/login', { username: rl, password: 'secret1' });
    if (!r2.user || r2.user.username !== rl) throw new Error('unlock failed');
    const r3 = await j('POST', '/api/auth/login', { username: UNIQ, password: 'secret1' });
    if (r3.user.username !== UNIQ) throw new Error('cookie restore failed');
  });

  await step('register throttle (10/hour/IP -> 429, then window resets)', async () => {
    const execFileSync = require('child_process').execFileSync;
    const php = (code) => execFileSync('C:/wamp64/bin/php/php8.4.0/php.exe', ['-r',
      `require ${JSON.stringify(path.join(__dirname, '..', 'src', 'db.php'))}; ${code}`]);
    try {
      // Fresh start: the bucket must be empty so we know the exact count.
      php("db()->exec('DELETE FROM login_attempts');");
      const base = 'spam' + Date.now().toString(36);
      for (let i = 0; i < 10; i++) {
        await j('POST', '/api/auth/register', { username: base + '_' + i, password: 'secret1' });
      }
      try { await j('POST', '/api/auth/register', { username: base + '_10', password: 'secret1' }); throw new Error('expected 429'); }
      catch (e) { if (!/429/.test(e.message)) throw e; }
      // Clear all throttle state so the rest of this run — and the other
      // suites — can keep registering.
      php("db()->exec('DELETE FROM login_attempts');");
      const ok = await j('POST', '/api/auth/register', { username: base + '_11', password: 'secret1' });
      if (!ok.user || ok.user.username !== base + '_11') throw new Error('register after cleanup failed');
    } finally {
      const r = await j('POST', '/api/auth/login', { username: UNIQ, password: 'secret1' });
      if (r.user.username !== UNIQ) throw new Error('cookie restore failed');
    }
  });

  let boardId, colA, colB, cardId, labelId, itemId, commentId, zipCommentId, xssCommentId, attId;

  await step('boards list empty', async () => {
    const r = await j('GET', '/api/boards');
    if (!Array.isArray(r.boards)) throw new Error('boards not array');
  });

  await step('create board', async () => {
    const r = await j('POST', '/api/boards', { title: 'Test Board', theme: '#3b82f6' });
    boardId = r.board.id;
    if (!boardId) throw new Error('no board id');
  });

  await step('board snapshot has columns', async () => {
    const r = await j('GET', `/api/boards/${boardId}`);
    if (!r.board || !Array.isArray(r.columns)) throw new Error('bad snapshot');
  });

  await step('add columns', async () => {
    const a = await j('POST', `/api/boards/${boardId}/columns`, { title: 'To Do' });
    colA = a.column.id;
    const b = await j('POST', `/api/boards/${boardId}/columns`, { title: 'Done' });
    colB = b.column.id;
    if (!colA || !colB) throw new Error('no column ids');
  });

  await step('rename + move column', async () => {
    await j('PUT', `/api/columns/${colA}`, { title: 'Todo' });
    await j('POST', `/api/columns/${colA}/move`, { position: 1 });
    const r = await j('GET', `/api/boards/${boardId}`);
    if (r.columns[1].id !== colA) throw new Error('move failed');
  });

  await step('create card', async () => {
    const r = await j('POST', `/api/columns/${colA}/cards`, { title: 'Card one' });
    cardId = r.card.id;
    if (!cardId) throw new Error('no card id');
  });

  await step('rich description sanitized', async () => {
    const r = await j('PUT', `/api/cards/${cardId}`, {
      description: '<p>Hello <b>world</b></p><script>alert(1)</script><img src=x onerror=alert(2)>'
        + '<title><script>alert(3)</script></title><form><input autofocus onfocus="alert(4)">',
    });
    if (r.card.description_html.includes('script')) throw new Error('script survived');
    if (r.card.description_html.includes('<img')) throw new Error('img survived');
    if (r.card.description_html.includes('<input') || r.card.description_html.includes('<form')) throw new Error('form/input survived');
    if (/on[a-z]+\s*=/.test(r.card.description_html)) throw new Error('handler survived');
    if (!r.card.description_html.includes('<b>world</b>')) throw new Error('bold lost');
  });

  await step('due date', async () => {
    const r = await j('PUT', `/api/cards/${cardId}`, { dueDate: '2026-12-31' });
    if (r.card.due_date !== '2026-12-31') throw new Error('due date not saved');
    await j('PUT', `/api/cards/${cardId}`, { dueDate: null });
  });

  await step('move card between columns', async () => {
    await j('POST', `/api/cards/${cardId}/move`, { columnId: colB, position: 0 });
    const r = await j('GET', `/api/cards/${cardId}`);
    if (r.card.column_id !== colB) throw new Error('card not moved');
  });

  await step('label', async () => {
    const r = await j('POST', `/api/cards/${cardId}/labels`, { text: 'urgent', color: '#ef4444' });
    labelId = r.label.id;
    if (!labelId) throw new Error('no label id');
  });

  await step('checklist add + toggle', async () => {
    const r = await j('POST', `/api/cards/${cardId}/checklist`, { text: 'buy milk' });
    itemId = r.item.id;
    const u = await j('PUT', `/api/checklist/${itemId}`, { checked: true });
    if (!u.item.checked) throw new Error('not checked');
  });

  await step('comment', async () => {
    const r = await j('POST', `/api/cards/${cardId}/comments`, { body: '<b>hi</b> <script>x</script>' });
    commentId = r.comment.id;
    if (!commentId || r.comment.body_html.includes('script')) throw new Error('comment bad');
  });

  await step('comment sanitizer kills script/handlers (unwrap bug regression)', async () => {
    const r = await j('POST', `/api/cards/${cardId}/comments`, {
      body: '<title><script>window.__xss=1</script></title>'
        + '<form><input autofocus onfocus="window.__xss=2"></form>'
        + '<a href="javascript:alert(1)">x</a><p onclick="alert(2)">y</p>'
        + '<!--[if IE]><script>window.__xss=3</script><![endif]-->',
    });
    xssCommentId = r.comment.id;
    if (!xssCommentId) throw new Error('no comment id');
    const h = r.comment.body_html.toLowerCase();
    if (h.includes('<script') || h.includes('</script')) throw new Error('script survived: ' + h);
    if (h.includes('<input') || h.includes('<form') || h.includes('<title')) throw new Error('wrapper survived: ' + h);
    if (/on[a-z]+\s*=/.test(h)) throw new Error('handler survived: ' + h);
    if (h.includes('javascript:')) throw new Error('js href survived: ' + h);
    if (h.includes('<!--')) throw new Error('comment survived: ' + h);
    if (!h.includes('window.__xss=1')) throw new Error('inert text lost: ' + h);
  });

  await step('attachment upload (png)', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const fd = new FormData();
    fd.append('file', new File([png], 'pixel.png', { type: 'image/png' }));
    const res = await fetch(`${BASE}/api/cards/${cardId}/attachments`, { method: 'POST', body: fd, headers: { cookie } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'upload failed');
    attId = data.attachment.id;
    if (data.attachment.mime !== 'image/png') throw new Error('mime sniff failed: ' + data.attachment.mime);
  });

  await step('binary file rejected (exe)', async () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.from([0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xFF, 0xFF]), Buffer.alloc(64, 0x13)]);
    const fd = new FormData();
    fd.append('file', new File([exe], 'virus.exe', { type: 'application/x-msdownload' }));
    const res = await fetch(`${BASE}/api/cards/${cardId}/attachments`, { method: 'POST', body: fd, headers: { cookie } });
    if (res.status !== 422) throw new Error('expected 422, got ' + res.status);
    const data = await res.json();
    if (!/File type not allowed/.test(data.error || '')) throw new Error('wrong error: ' + data.error);
  });

  await step('comment with zip attachment (multipart)', async () => {
    const zip = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
    const fd = new FormData();
    fd.append('body', '<b>doc attached</b>');
    fd.append('file', new File([zip], 'bundle.zip', { type: 'application/zip' }));
    const res = await fetch(`${BASE}/api/cards/${cardId}/comments`, { method: 'POST', body: fd, headers: { cookie } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'comment upload failed');
    zipCommentId = data.comment.id;
    if (!zipCommentId) throw new Error('no comment id');
    if (!data.comment.body_html.includes('doc attached')) throw new Error('body lost: ' + data.comment.body_html);
    if (!data.attachment || data.attachment.mime !== 'application/zip') throw new Error('zip attachment missing');
  });

  await step('card detail aggregates', async () => {
    const r = await j('GET', `/api/cards/${cardId}`);
    const c = r.card;
    if (c.labels.length !== 1) throw new Error('labels missing');
    if (c.checklist.length !== 1) throw new Error('checklist missing');
    if (c.comments.length !== 3) throw new Error('comments missing: ' + c.comments.length);
    const zipComment = c.comments.find((x) => x.id === zipCommentId);
    if (!zipComment || zipComment.attachments.length !== 1 || zipComment.attachments[0].name !== 'bundle.zip') {
      throw new Error('comment attachment missing: ' + JSON.stringify(c.comments));
    }
    if (c.attachments.length !== 1) throw new Error('card attachments should exclude comment ones');
    if (!c.badges || c.badges.checklist !== 1 || c.badges.comments !== 3) throw new Error('badges wrong: ' + JSON.stringify(c.badges));
  });

  const chunkedFile = (buf, name, type) => new File([buf], name, { type });

  await step('chunked upload happy path (3 chunks -> attach via fileId)', async () => {
    const text = Buffer.alloc(300 * 1024, 0x41); // 300 KB of 'A'
    const st = await j('POST', '/api/uploads/start', { name: 'chunked.txt', size: text.length });
    const fileId = st.fileId;
    if (!/^[a-f0-9]{32}$/.test(fileId || '')) throw new Error('bad fileId: ' + fileId);
    for (let i = 0; i < 3; i++) {
      const fd = new FormData();
      fd.append('fileId', fileId);
      fd.append('index', String(i));
      fd.append('chunk', chunkedFile(text.subarray(i * 100 * 1024, (i + 1) * 100 * 1024), 'c' + i, 'application/octet-stream'));
      const res = await fetch(`${BASE}/api/uploads/chunk`, { method: 'POST', body: fd, headers: { cookie } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'chunk ' + i + ' failed');
      if (data.received !== i + 1) throw new Error('received mismatch: ' + data.received);
    }
    const att = await j('POST', `/api/cards/${cardId}/attachments`, { fileId });
    if (!att.attachment || att.attachment.size !== text.length) throw new Error('attach failed: ' + JSON.stringify(att));
    if (att.attachment.mime !== 'text/plain') throw new Error('mime wrong: ' + att.attachment.mime);
    try { await j('POST', `/api/cards/${cardId}/attachments`, { fileId }); throw new Error('expected reuse failure'); }
    catch (e) { if (!/session incomplete/i.test(e.message)) throw e; }
    await j('DELETE', `/api/attachments/${att.attachment.id}`);
  });

  await step('chunk out of order -> 409', async () => {
    const st = await j('POST', '/api/uploads/start', { name: 'oob.txt', size: 200 * 1024 });
    const fd = new FormData();
    fd.append('fileId', st.fileId);
    fd.append('index', '1'); // skip 0
    fd.append('chunk', chunkedFile(Buffer.alloc(100 * 1024, 0x42), 'c1', 'application/octet-stream'));
    const res = await fetch(`${BASE}/api/uploads/chunk`, { method: 'POST', body: fd, headers: { cookie } });
    if (res.status !== 409) throw new Error('expected 409, got ' + res.status);
    await j('POST', '/api/uploads/abort', { fileId: st.fileId });
  });

  await step('chunked upload oversize rejected at start', async () => {
    const res = await fetch(`${BASE}/api/uploads/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: 'huge.bin', size: 5 * 1024 * 1024 + 1 }),
    });
    if (res.status !== 422) throw new Error('expected 422, got ' + res.status);
  });

  await step('chunked upload exceeds limit mid-stream -> 413', async () => {
    const st = await j('POST', '/api/uploads/start', { name: 'fat.txt', size: 5 * 1024 * 1024 });
    let got413 = false;
    for (let i = 0; i < 6; i++) {
      const fd = new FormData();
      fd.append('fileId', st.fileId);
      fd.append('index', String(i));
      fd.append('chunk', chunkedFile(Buffer.alloc(1024 * 1024, 0x43), 'c', 'application/octet-stream'));
      const res = await fetch(`${BASE}/api/uploads/chunk`, { method: 'POST', body: fd, headers: { cookie } });
      if (res.status === 413) { got413 = true; break; }
      if (!res.ok) throw new Error('chunk ' + i + ' failed: ' + res.status);
    }
    if (!got413) throw new Error('expected 413 mid-stream');
  });

  await step('chunked upload executable name rejected at start', async () => {
    const res = await fetch(`${BASE}/api/uploads/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: 'tool.exe', size: 100 }),
    });
    if (res.status !== 422) throw new Error('expected 422 at start, got ' + res.status);
    const data = await res.json();
    if (!/File type not allowed/.test(data.error || '')) throw new Error('wrong error: ' + data.error);
  });

  await step('chunked upload script content rejected at finalize', async () => {
    // content finfo positively identifies (text/html) smuggled under an
    // innocent extension: the extension fallback must not rescue it
    const st = await j('POST', '/api/uploads/start', { name: 'innocent.png', size: 100 });
    const fd = new FormData();
    fd.append('fileId', st.fileId);
    fd.append('index', '0');
    fd.append('chunk', chunkedFile(Buffer.from('<html><script>alert(1)</script></html>'), 'c0', 'application/octet-stream'));
    const up = await fetch(`${BASE}/api/uploads/chunk`, { method: 'POST', body: fd, headers: { cookie } });
    if (!up.ok) throw new Error('chunk failed: ' + up.status);
    const res = await fetch(`${BASE}/api/cards/${cardId}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ fileId: st.fileId }),
    });
    if (res.status !== 422) throw new Error('expected 422 at finalize, got ' + res.status);
    const data = await res.json();
    if (!/File type not allowed/.test(data.error || '')) throw new Error('wrong error: ' + data.error);
  });

  await step('comment with chunked upload (body + fileId)', async () => {
    const st = await j('POST', '/api/uploads/start', { name: 'note.txt', size: 50 });
    const fd = new FormData();
    fd.append('fileId', st.fileId);
    fd.append('index', '0');
    fd.append('chunk', chunkedFile(Buffer.from('hello chunk world'), 'c0', 'text/plain'));
    const up = await fetch(`${BASE}/api/uploads/chunk`, { method: 'POST', body: fd, headers: { cookie } });
    if (!up.ok) throw new Error('chunk failed: ' + up.status);
    const res = await j('POST', `/api/cards/${cardId}/comments`, { body: '<b>chunked</b> comment', fileId: st.fileId });
    if (!res.comment || !res.comment.body_html.includes('chunked')) throw new Error('comment missing');
    if (!res.attachment || res.attachment.name !== 'note.txt' || res.attachment.size !== 17) {
      throw new Error('attachment wrong: ' + JSON.stringify(res.attachment));
    }
    await j('DELETE', `/api/comments/${res.comment.id}`);
  });

  await step('other user cannot access board (404)', async () => {
    const r2 = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: UNIQ + 'b', password: 'secret1' }),
    });
    const other = await r2.json();
    const otherCookie = (r2.headers.get('set-cookie') || '').match(/dockup_session=[^;,]+/g)?.pop() || '';
    const res = await fetch(`${BASE}/api/boards/${boardId}`, { headers: { cookie: otherCookie } });
    if (res.status !== 404) throw new Error('expected 404, got ' + res.status);
  });

  await step('SSE stream opens and ends cleanly', async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${BASE}/api/events?board=${boardId}`, { headers: { cookie }, signal: ctrl.signal });
    if (!res.ok) throw new Error('sse status ' + res.status);
    const reader = res.body.getReader();
    let text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
    }
    clearTimeout(timer);
    if (!text.includes(': connected')) throw new Error('no connect frame seen');
  });

  await step('delete attachment/label/item/comment', async () => {
    await j('DELETE', `/api/attachments/${attId}`);
    await j('DELETE', `/api/labels/${labelId}`);
    await j('DELETE', `/api/checklist/${itemId}`);
    await j('DELETE', `/api/comments/${commentId}`);
    await j('DELETE', `/api/comments/${zipCommentId}`);
    await j('DELETE', `/api/comments/${xssCommentId}`);
    const r = await j('GET', `/api/cards/${cardId}`);
    if (r.card.attachments.length || r.card.labels.length || r.card.checklist.length || r.card.comments.length) {
      throw new Error('not all deleted');
    }
  });

  await step('delete card + column + board', async () => {
    await j('DELETE', `/api/cards/${cardId}`);
    await j('DELETE', `/api/columns/${colA}`);
    await j('DELETE', `/api/columns/${colB}`);
    await j('DELETE', `/api/boards/${boardId}`);
    try { await j('GET', `/api/boards/${boardId}`); throw new Error('expected 404'); }
    catch (e) { if (!/404/.test(e.message)) throw e; }
  });

  await step('board delete removes files from disk', async () => {
    const b = await j('POST', '/api/boards', { title: 'file-cleanup' });
    const bid = b.board.id;
    const col = await j('POST', `/api/boards/${bid}/columns`, { title: 'T' });
    const c = await j('POST', `/api/columns/${col.column.id}/cards`, { title: 'c' });
    const fd = new FormData();
    fd.append('file', new File([Buffer.from([0x50, 0x4B, 0x03, 0x04])], 'junk.zip', { type: 'application/zip' }));
    const res = await fetch(`${BASE}/api/cards/${c.card.id}/attachments`, { method: 'POST', body: fd, headers: { cookie } });
    const att = (await res.json()).attachment;
    if (!att || !att.stored) throw new Error('no attachment stored');
    const full = path.join(UPLOAD_DIR_LOCAL, att.stored);
    if (!fs.existsSync(full)) throw new Error('file not on disk: ' + full);
    await j('DELETE', `/api/boards/${bid}`);
    if (fs.existsSync(full)) throw new Error('file left on disk after board delete: ' + full);
  });

  console.log(process.exitCode ? '\n== SOME TESTS FAILED ==' : '\n== ALL V2 API TESTS PASSED ==');
})();
