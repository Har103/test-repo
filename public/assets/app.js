'use strict';

/* ================================================================== *
 *  Dockup — Trello-style boards. Vanilla JS, zero libraries.         *
 * ================================================================== */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const API_BASE = (window.APP_BASE || '').replace(/\/+$/, '');

/* ----------------------------- API ------------------------------- */

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, opts);
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401) { location.reload(); throw new Error('Session expired'); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const Api = {
  login: (username, password) => api('POST', '/api/auth/login', { username, password }),
  register: (username, password) => api('POST', '/api/auth/register', { username, password }),
  logout: () => api('POST', '/api/auth/logout'),
  boards: () => api('GET', '/api/boards'),
  createBoard: (title, theme) => api('POST', '/api/boards', { title, theme }),
  updateBoard: (id, patch) => api('PUT', `/api/boards/${id}`, patch),
  deleteBoard: (id) => api('DELETE', `/api/boards/${id}`),
  board: (id) => api('GET', `/api/boards/${id}`),
  health: () => api('GET', '/api/health'),
  seed: () => api('POST', '/api/seed'),
  addColumn: (boardId, title) => api('POST', `/api/boards/${boardId}/columns`, { title }),
  renameColumn: (id, title) => api('PUT', `/api/columns/${id}`, { title }),
  deleteColumn: (id) => api('DELETE', `/api/columns/${id}`),
  moveColumn: (id, position) => api('POST', `/api/columns/${id}/move`, { position }),
  addCard: (columnId, title) => api('POST', `/api/columns/${columnId}/cards`, { title }),
  card: (id) => api('GET', `/api/cards/${id}`),
  updateCard: (id, patch) => api('PUT', `/api/cards/${id}`, patch),
  deleteCard: (id) => api('DELETE', `/api/cards/${id}`),
  moveCard: (id, columnId, position) => api('POST', `/api/cards/${id}/move`, { columnId, position }),
  addLabel: (cardId, text, color) => api('POST', `/api/cards/${cardId}/labels`, { text, color }),
  deleteLabel: (id) => api('DELETE', `/api/labels/${id}`),
  addChecklistItem: (cardId, text) => api('POST', `/api/cards/${cardId}/checklist`, { text }),
  updateChecklistItem: (id, patch) => api('PUT', `/api/checklist/${id}`, patch),
  deleteChecklistItem: (id) => api('DELETE', `/api/checklist/${id}`),
  addComment: (cardId, body) => api('POST', `/api/cards/${cardId}/comments`, { body }),
  deleteComment: (id) => api('DELETE', `/api/comments/${id}`),
  deleteAttachment: (id) => api('DELETE', `/api/attachments/${id}`),
  upload: (cardId, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return fetch(`${API_BASE}/api/cards/${cardId}/attachments`, { method: 'POST', body: fd })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
      });
  },
};

/* ----------------------------- utils ----------------------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function timeAgo(ts) {
  const ms = Date.now() - new Date(String(ts).replace(' ', 'T') + 'Z').getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

function initials(name) {
  return name.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(' ').slice(0, 2)
    .map((w) => w[0]).join('').toUpperCase() || '?';
}

const hue = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 45% 45%)`;
};

function showBanner(msg) {
  const b = $('#banner');
  if (!b) return;
  b.textContent = msg;
  b.classList.remove('hidden');
  setTimeout(() => b.classList.add('hidden'), 8000);
}

/* ---------------------------- transport -------------------------- */

const Transport = {
  sse: 'sse',
  ws: 'ws',
  current: localStorage.getItem('dockup.transport') || 'sse',
};

let live = null;
let transportOpened = false;

function setConnState(ok, label) {
  transportOpened = transportOpened || ok;
  $('#conn-dot').className = 'dot ' + (ok ? 'ok' : 'bad');
  $('#conn-label').textContent = label;
}

const SseTransport = {
  name: 'SSE',
  es: null,
  boardId: 0,
  connect(onEvent, boardId) {
    this.close();
    this.boardId = boardId;
    this.es = new EventSource(`${API_BASE}/api/events?board=${boardId}`);
    this.es.onopen = () => setConnState(true, `${this.name} · connected`);
    this.es.onerror = () => setConnState(false, `${this.name} · reconnecting…`);
    this.es.addEventListener('message', (e) => onEvent(JSON.parse(e.data)));
  },
  close() {
    if (this.es) { this.es.close(); this.es = null; }
  },
};

const WsTransport = {
  name: 'WebSocket',
  ws: null,
  wsUrl: null,
  statusTimer: null,
  closed: false,
  onEvent: null,

  connect(onEvent) {
    this.onEvent = onEvent;
    this.closed = false;
    Api.health().then((h) => {
      if (this.closed) return;
      this.wsUrl = h.wsUrl;
      this.open();
    }).catch(() => {
      if (!this.closed) setConnState(false, `${this.name} · ws server unreachable`);
    });
  },
  open() {
    if (this.closed) return;
    this.ws = new WebSocket(this.wsUrl);
    this.ws.onopen = () => {
      setConnState(true, `${this.name} · connected`);
      this.pollClients(true);
      if (this.statusTimer) clearInterval(this.statusTimer);
      this.statusTimer = setInterval(() => this.pollClients(false), 5000);
      this.sendPing();
    };
    this.ws.onclose = () => {
      setConnState(false, `${this.name} · reconnecting…`);
      if (this.statusTimer) clearInterval(this.statusTimer);
      setTimeout(() => this.open(), 2000);
    };
    this.ws.onerror = () => this.ws.close();
    this.ws.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === '__pong') return;
      this.onEvent(ev);
    };
  },
  sendPing() {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ type: '__ping' }));
      setTimeout(() => this.sendPing(), 15000);
    }
  },
  pollClients() {
    fetch(this.wsUrl.replace(/^ws/, 'http').replace(/\/$/, '') + '/status')
      .then((r) => r.json())
      .then((s) => { $('#conn-clients').textContent = s.clients > 0 ? `· ${s.clients} client${s.clients === 1 ? '' : 's'}` : ''; })
      .catch(() => {});
  },
  close() {
    this.closed = true;
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
  },
};

function startLive() {
  if (live) { live.close(); live = null; }
  transportOpened = false;
  setConnState(false, 'connecting…');

  const onEvent = (ev) => {
    applyEvent(ev);
    feedEvent(ev);
  };

  live = Transport.current === Transport.ws ? WsTransport : SseTransport;
  if (live === SseTransport) {
    live.connect(onEvent, State.board ? State.board.board.id : 0);
  } else {
    live.connect(onEvent);
  }

  setTimeout(() => {
    if (live && !transportOpened) {
      setConnState(false, live.name === 'WebSocket'
        ? 'WebSocket unreachable — is board_ws running?'
        : 'SSE not responding');
    }
  }, 6000);
}

/* ------------------------------ state ---------------------------- */

const State = {
  user: window.CURRENT_USER,
  boards: [],
  board: null,          // { board, columns: [...] }
  currentCard: null,    // detail object while modal open
};

/* ------------------------- auth screen --------------------------- */

function toggleAuth(showLogin) {
  $('#login-form').classList.toggle('hidden', !showLogin);
  $('#register-form').classList.toggle('hidden', showLogin);
}

$('#show-register')?.addEventListener('click', (e) => { e.preventDefault(); toggleAuth(false); });
$('#show-login')?.addEventListener('click', (e) => { e.preventDefault(); toggleAuth(true); });

async function submitAuth(form, msgEl, fn) {
  msgEl.textContent = '';
  try {
    const res = await fn();
    State.user = res.user;
    enterApp();
  } catch (e) {
    msgEl.textContent = e.message;
    msgEl.className = 'auth-msg error';
  }
}

$('#login-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  submitAuth(e.target, $('#login-msg'),
    () => Api.login($('#login-user').value.trim(), $('#login-pass').value));
});

$('#register-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  submitAuth(e.target, $('#reg-msg'),
    () => Api.register($('#reg-user').value.trim(), $('#reg-pass').value));
});

$('#btn-logout')?.addEventListener('click', async () => {
  await Api.logout().catch(() => {});
  location.reload();
});

/* --------------------------- app shell --------------------------- */

function enterApp() {
  $('#auth-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#avatar').textContent = initials(State.user.username);
  $('#username').textContent = State.user.username;
  $('#avatar').style.background = hue(State.user.username);
  bindBoardViewEvents();
  loadBoards();
}

function showView(name) {
  $('#view-boards').classList.toggle('hidden', name !== 'boards');
  $('#view-board').classList.toggle('hidden', name !== 'board');
}

async function loadBoards() {
  const res = await Api.boards();
  State.boards = res.boards;
  renderBoardsGrid();
  showView('boards');
  $('#board-title').textContent = '';
  stopLiveForBoard();
}

function renderBoardsGrid() {
  const grid = $('#boards-grid');
  grid.innerHTML = '';
  if (State.boards.length === 0) {
    grid.innerHTML = '<p class="muted">No boards yet — create your first one.</p>';
  }
  State.boards.forEach((b) => {
    const tile = document.createElement('div');
    tile.className = 'board-tile';
    tile.style.setProperty('--tile', b.theme || '#0b6e4f');
    tile.innerHTML = `
      <div class="board-tile-title">${escapeHtml(b.title)}</div>
      <div class="board-tile-meta">${b.card_count} card${b.card_count === 1 ? '' : 's'}</div>`;
    tile.addEventListener('click', () => openBoard(b.id));
    grid.appendChild(tile);
  });
}

/* --------------------------- board view -------------------------- */

let dragging = false;
let renderQueued = false;
let dragSource = null;

function bindBoardViewEvents() {
  $('#btn-boards').addEventListener('click', () => { stopLiveForBoard(); loadBoards(); });
  $('#btn-new-board').addEventListener('click', () => {
    $('#board-modal-title').value = '';
    $('#board-modal').showModal();
  });
  $('#btn-rename-board').addEventListener('click', () => {
    const title = prompt('Rename board', State.board.board.title);
    if (title && title.trim()) {
      Api.updateBoard(State.board.board.id, { title: title.trim() }).then((r) => {
        State.board.board = r.board;
        $('#board-title').textContent = r.board.title;
      }).catch((e) => showBanner(e.message));
    }
  });
  $('#btn-seed').addEventListener('click', async () => {
    await Api.seed().catch((e) => showBanner(e.message));
    await loadBoards();
  });
  $('#btn-delete-board').addEventListener('click', async () => {
    if (!confirm('Delete this board and everything on it?')) return;
    try {
      await Api.deleteBoard(State.board.board.id);
      stopLiveForBoard();
      loadBoards();
    } catch (e) { showBanner(e.message); }
  });

  $('#theme-palette').innerHTML = ['#0b6e4f', '#3b82f6', '#8b5cf6', '#ec4899',
    '#f59e0b', '#ef4444', '#14b8a6', '#64748b']
    .map((c) => `<span class="theme-swatch" data-c="${c}" style="background:${c}"></span>`)
    .join('');
  $('#theme-palette').addEventListener('click', (e) => {
    const sw = e.target.closest('.theme-swatch');
    if (!sw) return;
    $('#theme-palette').querySelectorAll('.theme-swatch').forEach((s) => s.classList.remove('active'));
    sw.classList.add('active');
  });

  $('#btn-create-board').addEventListener('click', async () => {
    const title = $('#board-modal-title').value.trim();
    if (!title) return;
    const active = $('#theme-palette .active');
    const theme = active ? active.dataset.c : '#0b6e4f';
    try {
      const res = await Api.createBoard(title, theme);
      $('#board-modal').close();
      openBoard(res.board.id);
    } catch (e) { showBanner(e.message); }
  });
}

function stopLiveForBoard() {
  State.board = null;
  if (live === SseTransport) live.close();
}

async function openBoard(boardId) {
  try {
    const res = await Api.board(boardId);
    State.board = res;
    $('#board-title').textContent = res.board.title;
    document.title = res.board.title + ' · Dockup';
    showView('board');
    renderBoard();
    startLive();
    const h = await Api.health().catch(() => null);
    if (h && /development server/i.test(h.server || '')) {
      showBanner('You are on the single-threaded `php -S` server — SSE will block requests. Use Apache, or switch to WebSocket in Settings.');
    }
  } catch (e) {
    showBanner(e.message);
    loadBoards();
  }
}

function renderBoard() {
  if (dragging) { renderQueued = true; return; }
  const boardEl = $('#board');
  const board = State.board;
  if (!board) return;

  const keep = new Set(board.columns.map((c) => `col-${c.id}`));
  $$('.column').forEach((el) => { if (!keep.has(el.dataset.col)) el.remove(); });

  board.columns.forEach((col) => {
    let el = $(`#col-${col.id}`);
    if (!el) {
      el = document.createElement('section');
      el.className = 'column';
      el.id = `col-${col.id}`;
      el.dataset.col = `col-${col.id}`;
      el.draggable = true;
      el.innerHTML = `
        <div class="col-head">
          <span class="col-grip">⋮⋮</span>
          <h2 class="col-title" title="Double-click to rename"></h2>
          <span class="col-count"></span>
          <button class="btn icon del-col" title="Delete column">✕</button>
        </div>
        <div class="col-body"></div>
        <button class="btn ghost add-card">+ Add card</button>`;
      bindColumnEvents(el);
      boardEl.appendChild(el);
    }
    renderColumn(el, col);
  });
}

function renderColumn(el, col) {
  el.dataset.columnId = col.id;
  el.querySelector('.col-title').textContent = col.title;
  el.querySelector('.col-count').textContent = (col.cards || []).length;
  const body = el.querySelector('.col-body');

  const keep = new Set((col.cards || []).map((c) => `card-${c.id}`));
  body.querySelectorAll('.card').forEach((node) => {
    if (!keep.has(node.dataset.card)) node.remove();
  });

  (col.cards || []).forEach((card) => {
    let node = body.querySelector(`[data-card="card-${card.id}"]`);
    if (!node) {
      node = document.createElement('article');
      node.className = 'card';
      node.dataset.card = `card-${card.id}`;
      node.draggable = true;
      bindCardEvents(node);
      body.appendChild(node);
    }
    renderCard(node, card);
  });
}

function renderCard(node, card) {
  node.dataset.cardId = card.id;
  const labels = (card.labels || []).map((l) =>
    `<span class="lbl" style="background:${l.color}">${escapeHtml(l.text)}</span>`).join('');

  let badges = '';
  const b = card.badges || {};
  if (b.checklist) {
    const pct = b.checklist_done / b.checklist;
    badges += `<span class="badge ${pct === 1 ? 'done' : ''}">☑ ${b.checklist_done}/${b.checklist}</span>`;
  }
  if (b.comments) badges += `<span class="badge">💬 ${b.comments}</span>`;
  if (b.attachments) badges += `<span class="badge">📎 ${b.attachments}</span>`;
  if (card.due_date) {
    const d = new Date(card.due_date + 'T00:00:00');
    const overdue = d < new Date(Date.now() - 86400000);
    badges += `<span class="badge due ${overdue ? 'overdue' : ''}">🗓 ${escapeHtml(card.due_date)}</span>`;
  }

  node.innerHTML = `
    ${labels ? `<div class="card-labels">${labels}</div>` : ''}
    <div class="card-title">${escapeHtml(card.title)}</div>
    ${badges ? `<div class="card-badges">${badges}</div>` : ''}`;
}

/* ------------------------ drag & drop (cards) -------------------- */

function bindCardEvents(node) {
  node.addEventListener('dragstart', (e) => {
    dragging = true;
    dragSource = node.dataset.cardId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', node.dataset.cardId);
    requestAnimationFrame(() => node.classList.add('dragging'));
  });
  node.addEventListener('dragend', () => {
    node.classList.remove('dragging');
    clearDropMarks();
    dragging = false;
    dragSource = null;
    if (renderQueued) { renderQueued = false; renderBoard(); }
  });
  node.addEventListener('click', () => openCardModal(Number(node.dataset.cardId)));
}

function bindColumnEvents(el) {
  const body = el.querySelector('.col-body');

  el.querySelector('.del-col').addEventListener('click', () => {
    if (confirm('Delete this column and all its cards?')) {
      Api.deleteColumn(Number(el.dataset.columnId)).catch((e) => showBanner(e.message));
    }
  });
  el.querySelector('.col-title').addEventListener('dblclick', () => {
    const title = prompt('Rename column', el.querySelector('.col-title').textContent);
    if (title && title.trim()) {
      Api.renameColumn(Number(el.dataset.columnId), title.trim()).catch((e) => showBanner(e.message));
    }
  });
  el.querySelector('.add-card').addEventListener('click', () => {
    const title = prompt('Card title');
    if (title && title.trim()) {
      Api.addCard(Number(el.dataset.columnId), title.trim()).catch((e) => showBanner(e.message));
    }
  });

  body.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!dragSource) return;
    const pos = dropPosition(body, e.clientY);
    clearDropMarks();
    const cards = body.querySelectorAll('.card');
    if (pos < cards.length) cards[pos].classList.add('drop-before');
    else body.classList.add('drop-tail');
  });
  body.addEventListener('drop', (e) => {
    e.preventDefault();
    const cardId = Number(dragSource);
    dragSource = null;
    if (!cardId) return;
    clearDropMarks();
    Api.moveCard(cardId, Number(el.dataset.columnId), dropPosition(body, e.clientY))
      .catch((err) => showBanner(err.message));
  });
  body.addEventListener('dragleave', () => body.classList.remove('drop-tail'));
}

// column drag reorder
$('#board')?.addEventListener('dragstart', (e) => {
  if (e.target.classList.contains('column')) {
    dragging = true;
    dragColumn = e.target.dataset.columnId;
    requestAnimationFrame(() => e.target.classList.add('dragging-col'));
  }
});
$('#board')?.addEventListener('dragover', (e) => {
  if (!dragColumn) return;
  const col = e.target.closest('.column');
  if (!col) return;
  e.preventDefault();
  clearColumnMarks();
  const cols = [...$$('.column')].filter((c) => c.dataset.columnId !== dragColumn);
  const before = cols.find((c) => e.clientX < c.getBoundingClientRect().left + c.offsetWidth / 2);
  if (before) before.classList.add('col-drop-before');
  else (cols[cols.length - 1] || col).classList.add('col-drop-after');
});
$('#board')?.addEventListener('drop', (e) => {
  if (!dragColumn) return;
  e.preventDefault();
  const col = e.target.closest('.column');
  const cols = [...$$('.column')].filter((c) => c.dataset.columnId !== dragColumn);
  let pos = cols.length;
  if (col) {
    const before = cols.find((c) => e.clientX < c.getBoundingClientRect().left + c.offsetWidth / 2);
    pos = before ? cols.indexOf(before) : cols.length;
  }
  const id = Number(dragColumn);
  dragColumn = null;
  dragging = false;
  dragSource = null;
  clearColumnMarks();
  if (renderQueued) { renderQueued = false; }
  Api.moveColumn(id, pos).catch((err) => showBanner(err.message));
  if (renderQueued) renderBoard();
});
$('#board')?.addEventListener('dragend', (e) => {
  if (e.target.classList.contains('column')) {
    dragColumn = null;
    dragging = false;
    clearColumnMarks();
    if (renderQueued) { renderQueued = false; renderBoard(); }
  }
});

let dragColumn = null;

function clearColumnMarks() {
  $$('.col-drop-before, .col-drop-after').forEach((el) =>
    el.classList.remove('col-drop-before', 'col-drop-after'));
}

function dropPosition(body, y) {
  const cards = [...body.querySelectorAll('.card')];
  for (let i = 0; i < cards.length; i++) {
    if (y < cards[i].getBoundingClientRect().top + cards[i].offsetHeight / 2) return i;
  }
  return cards.length;
}

function clearDropMarks() {
  $$('.drop-before, .drop-tail').forEach((el) =>
    el.classList.remove('drop-before', 'drop-tail'));
}

/* --------------------------- card modal -------------------------- */

const LABEL_COLORS = ['#3b82f6', '#ef4444', '#f59e0b', '#22c55e', '#8b5cf6', '#14b8a6', '#ec4899', '#64748b'];

async function openCardModal(cardId) {
  try {
    const res = await Api.card(cardId);
    State.currentCard = res.card;
    renderCardModal();
    $('#card-modal').showModal();
  } catch (e) { showBanner(e.message); }
}

function renderCardModal() {
  const card = State.currentCard;
  if (!card) return;
  const board = State.board;

  $('#cm-board-name').textContent = (board ? board.board.title + ' · ' : '') + '#' + card.id;
  $('#cm-title').value = card.title;
  $('#cm-desc').innerHTML = card.description_html || '';
  $('#cm-due').value = card.due_date || '';
  $('#cm-desc-status').textContent = '';

  renderLabels(card.labels || []);
  renderChecklist(card.checklist || []);
  renderComments(card.comments || []);
  renderAttachments(card.attachments || []);
}

function renderLabels(labels) {
  const box = $('#cm-labels');
  box.innerHTML = '';
  labels.forEach((l) => {
    const chip = document.createElement('span');
    chip.className = 'lbl clickable';
    chip.style.background = l.color;
    chip.textContent = l.text || 'label';
    chip.title = 'Click to remove';
    chip.addEventListener('click', () => {
      Api.deleteLabel(l.id).catch((e) => showBanner(e.message));
    });
    box.appendChild(chip);
  });
  if (!labels.length) box.innerHTML = '<span class="muted">No labels</span>';
}

function renderChecklist(items) {
  const list = $('#cm-checklist');
  list.innerHTML = '';
  const done = items.filter((i) => i.checked).length;
  $('#cm-cl-progress').textContent = items.length ? `${done}/${items.length}` : '';
  $('#cm-cl-bar').style.width = items.length ? `${Math.round(done / items.length * 100)}%` : '0';

  items.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'cl-item' + (item.checked ? ' checked' : '');
    li.innerHTML = `
      <input type="checkbox" ${item.checked ? 'checked' : ''}>
      <span class="cl-text">${escapeHtml(item.text)}</span>
      <button class="btn icon" title="Delete item">✕</button>`;
    li.querySelector('input').addEventListener('change', (e) => {
      Api.updateChecklistItem(item.id, { checked: e.target.checked }).catch((err) => showBanner(err.message));
    });
    li.querySelector('.btn').addEventListener('click', () => {
      Api.deleteChecklistItem(item.id).catch((err) => showBanner(err.message));
    });
    list.appendChild(li);
  });
}

function renderComments(comments) {
  const box = $('#cm-comments');
  box.innerHTML = '';
  if (!comments.length) box.innerHTML = '<span class="muted">No comments yet.</span>';
  comments.forEach((c) => {
    const div = document.createElement('div');
    div.className = 'comment';
    div.innerHTML = `
      <div class="comment-head">
        <span class="avatar sm" style="background:${hue(c.username)}">${escapeHtml(initials(c.username))}</span>
        <span class="comment-user">${escapeHtml(c.username)}</span>
        <span class="comment-time">${timeAgo(c.created_at)}</span>
        ${c.user_id === State.user.id ? '<button class="btn icon" title="Delete comment">✕</button>' : ''}
      </div>
      <div class="comment-body">${c.body_html || ''}</div>`;
    const del = div.querySelector('.btn');
    if (del) {
      del.addEventListener('click', () => {
        if (confirm('Delete this comment?')) {
          Api.deleteComment(c.id).catch((e) => showBanner(e.message));
        }
      });
    }
    box.appendChild(div);
  });
}

function renderAttachments(atts) {
  const box = $('#cm-attachments');
  box.innerHTML = '';
  if (!atts.length) box.innerHTML = '<span class="muted">No attachments</span>';
  atts.forEach((a) => {
    const url = `${API_BASE}/uploads/${a.stored}`;
    const div = document.createElement('div');
    div.className = 'attachment';
    const preview = a.mime.startsWith('image/')
      ? `<img src="${url}" alt="${escapeHtml(a.name)}" loading="lazy">`
      : `<div class="file-icon">📄</div>`;
    div.innerHTML = `
      ${preview}
      <div class="attachment-meta">
        <a href="${url}" target="_blank" rel="noopener">${escapeHtml(a.name)}</a>
        <span>${(a.size / 1024).toFixed(0)} KB</span>
      </div>
      <button class="btn icon" title="Delete attachment">✕</button>`;
    div.querySelector('.btn').addEventListener('click', () => {
      if (confirm('Delete this attachment?')) {
        Api.deleteAttachment(a.id).catch((e) => showBanner(e.message));
      }
    });
    box.appendChild(div);
  });
}

/* rich text editor */

function bindEditorToolbar(scope) {
  scope.querySelectorAll('[data-cmd]').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      const cmd = btn.dataset.cmd;
      const val = btn.dataset.val;
      if (cmd === 'createLink') {
        const url = prompt('Link URL (https://…)');
        if (url) document.execCommand('createLink', false, url);
        return;
      }
      document.execCommand(cmd, false, val || null);
    });
  });
}

$('#cm-save-desc').addEventListener('click', async () => {
  const html = $('#cm-desc').innerHTML;
  $('#cm-desc-status').textContent = 'saving…';
  try {
    await Api.updateCard(State.currentCard.id, { description: html });
    $('#cm-desc-status').textContent = 'saved ✓';
    setTimeout(() => { $('#cm-desc-status').textContent = ''; }, 1500);
  } catch (e) {
    $('#cm-desc-status').textContent = 'error';
    showBanner(e.message);
  }
});

$('#cm-title').addEventListener('change', async () => {
  const title = $('#cm-title').value.trim();
  if (!title) return;
  try {
    await Api.updateCard(State.currentCard.id, { title });
    State.currentCard.title = title;
    const col = State.board.columns.find((c) => c.id === State.currentCard.column_id);
    const card = (col.cards || []).find((c) => c.id === State.currentCard.id);
    if (card) card.title = title;
    renderBoard();
  } catch (e) { showBanner(e.message); }
});

$('#cm-due').addEventListener('change', () => {
  Api.updateCard(State.currentCard.id, { dueDate: $('#cm-due').value || null })
    .then((r) => { State.currentCard.due_date = r.card.due_date; })
    .catch((e) => showBanner(e.message));
});

$('#cm-close').addEventListener('click', () => $('#card-modal').close());
$('#card-modal').addEventListener('click', (e) => {
  if (e.target === $('#card-modal')) $('#card-modal').close();
});

$('#cm-delete').addEventListener('click', async () => {
  if (!confirm('Delete this card?')) return;
  try {
    await Api.deleteCard(State.currentCard.id);
    $('#card-modal').close();
    State.currentCard = null;
  } catch (e) { showBanner(e.message); }
});

/* labels */
$('#cm-add-label').addEventListener('click', () => {
  const text = prompt('Label text (optional)');
  const color = LABEL_COLORS[Math.floor(Math.random() * LABEL_COLORS.length)];
  Api.addLabel(State.currentCard.id, text || '', color).catch((e) => showBanner(e.message));
});

/* checklist */
$('#cm-checklist-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#cm-checklist-input').value.trim();
  if (!text) return;
  Api.addChecklistItem(State.currentCard.id, text).catch((err) => showBanner(err.message));
  $('#cm-checklist-input').value = '';
});

/* comments */
$('#cm-save-comment').addEventListener('click', async () => {
  const body = $('#cm-comment-input').innerHTML;
  if (!body || !body.replace(/<br>|<div><br><\/div>|\s/g, '')) return;
  try {
    await Api.addComment(State.currentCard.id, body);
    $('#cm-comment-input').innerHTML = '';
  } catch (e) { showBanner(e.message); }
});

/* attachments */
$('#cm-attach-btn').addEventListener('click', () => $('#cm-attach-file').click());
$('#cm-attach-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    await Api.upload(State.currentCard.id, file);
  } catch (err) { showBanner(err.message); }
});

bindEditorToolbar(document);

/* --------------------------- event pipeline ---------------------- */

async function refreshCard(id) {
  const res = await Api.card(id);
  const card = res.card;
  const col = State.board.columns.find((c) => c.id === card.column_id);
  if (col) {
    const i = col.cards.findIndex((c) => c.id === card.id);
    if (i !== -1) col.cards[i] = card;
    else col.cards.push(card);
    col.cards.sort((a, b) => a.position - b.position);
    renderBoard();
  }
  if (State.currentCard && State.currentCard.id === id) {
    State.currentCard = card;
    renderCardModal();
  }
}

function applyEvent(ev) {
  if (!State.board || ev.boardId !== State.board.board.id) return;
  const { type, data } = ev;

  // Board-level events caused by this session are already reflected in the
  // UI (the initiating tab got the response directly); re-applying them
  // would e.g. yank the view back to the boards grid right after creation.
  if (type.startsWith('board.') && State.user && ev.actor === State.user.username) {
    return;
  }

  switch (type) {
    case 'column.created': upsertColumn(data.column); break;
    case 'column.updated': upsertColumn(data.column); break;
    case 'column.moved': upsertColumn(data.column); break;
    case 'column.deleted': removeColumn(data.id); break;
    case 'card.created': upsertCard(data.card); break;
    case 'card.updated': upsertCard(data.card); break;
    case 'card.moved': upsertCard(data.card); break;
    case 'card.deleted': removeCard(data.id); break;
    case 'label.created':
    case 'label.deleted':
    case 'checklist.created':
    case 'checklist.updated':
    case 'checklist.deleted':
    case 'comment.created':
    case 'comment.deleted':
    case 'attachment.created':
    case 'attachment.deleted': {
      const cardId = data.cardId || data.card?.id || data.comment?.card_id ||
                     data.attachment?.card_id || data.label?.card_id || data.item?.card_id;
      if (cardId) refreshCard(cardId).catch(() => {});
      break;
    }
    case 'board.updated':
      if (State.board) State.board.board = data.board;
      $('#board-title').textContent = data.board.title;
      document.title = data.board.title + ' · Dockup';
      break;
    case 'board.deleted':
      if (State.board && data.id === State.board.board.id) {
        stopLiveForBoard();
        loadBoards();
      }
      break;
    case 'board.created':
    case 'board.seeded':
      loadBoards();
      break;
  }
}

function upsertColumn(col) {
  const i = State.board.columns.findIndex((c) => c.id === col.id);
  if (i === -1) { col.cards = col.cards || []; State.board.columns.push(col); }
  else State.board.columns[i] = { ...State.board.columns[i], ...col, cards: State.board.columns[i].cards || col.cards || [] };
  State.board.columns.sort((a, b) => a.position - b.position);
  renderBoard();
}

function removeColumn(id) {
  State.board.columns = State.board.columns.filter((c) => c.id !== id);
  renderBoard();
}

function upsertCard(card) {
  const cols = State.board.columns;
  for (const c of cols) {
    c.cards = (c.cards || []).filter((x) => x.id !== card.id);
  }
  const col = cols.find((c) => c.id === card.column_id);
  if (col) {
    col.cards = col.cards || [];
    col.cards.push(card);
    col.cards.sort((a, b) => a.position - b.position);
  }
  renderBoard();
}

function removeCard(id) {
  for (const c of State.board.columns) {
    c.cards = (c.cards || []).filter((x) => x.id !== id);
  }
  if (State.currentCard && State.currentCard.id === id) {
    $('#card-modal').close();
    State.currentCard = null;
  }
  renderBoard();
}

/* ------------------------------ feed ----------------------------- */

let feedOpen = false;

function feedEvent(ev) {
  const list = $('#feed-list');
  if (!list) return;
  const li = document.createElement('li');
  const t = ev.type.replace(/\./g, ' ');
  li.innerHTML = `
    <span class="feed-time">${new Date().toLocaleTimeString()}</span>
    <span class="feed-actor">${escapeHtml(ev.actor || '')}</span>
    <span class="feed-type">${t}</span>`;
  list.prepend(li);
  while (list.children.length > 40) list.lastElementChild.remove();
  $('#feed-count').textContent = `last ${list.children.length}`;
}

$('#btn-feed')?.addEventListener('click', () => {
  feedOpen = !feedOpen;
  $('#feed').classList.toggle('hidden', !feedOpen);
  $('#btn-feed').classList.toggle('active', feedOpen);
});

/* --------------------------- settings ---------------------------- */

function openSettings() {
  $$('input[name="transport"]').forEach((r) => { r.checked = r.value === Transport.current; });
  $('#settings').showModal();
}

$('#btn-apply-settings')?.addEventListener('click', () => {
  const choice = document.querySelector('input[name="transport"]:checked').value;
  if (choice !== Transport.current) {
    Transport.current = choice;
    localStorage.setItem('dockup.transport', choice);
    startLive();
  }
  $('#settings').close();
});

$('#btn-settings')?.addEventListener('click', openSettings);

/* ------------------------------ boot ----------------------------- */

function boot() {
  bindEditorToolbar(document);
  if (State.user) {
    enterApp();
  }
}

document.addEventListener('DOMContentLoaded', boot);
