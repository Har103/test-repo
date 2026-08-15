'use strict';
/* API v2 smoke test: auth, boards, columns, cards, labels, checklist,
   comments, attachment upload (multipart), permissions, SSE. */

const BASE = process.env.APP_BASE || 'http://localhost/dockerup/public';

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

  let boardId, colA, colB, cardId, labelId, itemId, commentId, zipCommentId, attId;

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
      description: '<p>Hello <b>world</b></p><script>alert(1)</script><img src=x onerror=alert(2)>',
    });
    if (r.card.description_html.includes('script')) throw new Error('script survived');
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
    if (c.comments.length !== 2) throw new Error('comments missing: ' + c.comments.length);
    const zipComment = c.comments.find((x) => x.id === zipCommentId);
    if (!zipComment || zipComment.attachments.length !== 1 || zipComment.attachments[0].name !== 'bundle.zip') {
      throw new Error('comment attachment missing: ' + JSON.stringify(c.comments));
    }
    if (c.attachments.length !== 1) throw new Error('card attachments should exclude comment ones');
    if (!c.badges || c.badges.checklist !== 1 || c.badges.comments !== 2) throw new Error('badges wrong: ' + JSON.stringify(c.badges));
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

  console.log(process.exitCode ? '\n== SOME TESTS FAILED ==' : '\n== ALL V2 API TESTS PASSED ==');
})();
