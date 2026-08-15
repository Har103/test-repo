'use strict';

/* ------------------------------------------------------------------ *
 *  Realtime Task Board — vanilla JS, zero libraries.
 *  Two pluggable live transports, one event pipeline.
 * ------------------------------------------------------------------ */

const State = {
  columns: [],
  lastEventId: 0,
};

const Transport = {
  sse: 'sse',
  ws: 'ws',
  current: localStorage.getItem('board.transport') || 'sse',
};

let live = null;            // active transport instance
let dragging = false;       // pause re-renders mid-drag
let renderQueued = false;

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
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const Board = {
  get: () => api('GET', '/api/board'),
  health: () => api('GET', '/api/health'),
  seed: () => api('POST', '/api/seed'),
  addColumn: (title, color) => api('POST', '/api/columns', { title, color }),
  renameColumn: (id, title) => api('PUT', `/api/columns/${id}`, { title }),
  deleteColumn: (id) => api('DELETE', `/api/columns/${id}`),
  addCard: (columnId, title, note) => api('POST', '/api/cards', { columnId, title, note }),
  updateCard: (id, title, note) => api('PUT', `/api/cards/${id}`, { title, note }),
  deleteCard: (id) => api('DELETE', `/api/cards/${id}`),
  moveCard: (id, columnId, position) => api('POST', `/api/cards/${id}/move`, { columnId, position }),
};

/* -------------------------- Transports ---------------------------- */

const SseTransport = {
  kind: Transport.sse,
  name: 'SSE',
  es: null,

  connect(onEvent) {
    this.es = new EventSource(`${API_BASE}/api/events`);
    this.es.onopen = () => setConnState(true, `${this.name} · connected`);
    this.es.onerror = () => setConnState(false, `${this.name} · reconnecting…`);
    this.es.addEventListener('message', (e) => {
      State.lastEventId = Math.max(State.lastEventId, Number(e.lastEventId) || 0);
      onEvent(JSON.parse(e.data));
    });
  },
  close() {
    if (this.es) { this.es.close(); this.es = null; }
  },
};

const WsTransport = {
  kind: Transport.ws,
  name: 'WebSocket',
  ws: null,
  wsUrl: null,
  clients: null,
  statusTimer: null,
  closed: false,

  connect(onEvent) {
    this.closed = false;
    Board.health().then((h) => {
      if (this.closed) return;
      this.wsUrl = h.wsUrl;
      this.open(onEvent);
    }).catch(() => {
      if (!this.closed) setConnState(false, `${this.name} · ws server unreachable`);
    });
  },
  open(onEvent) {
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
      setTimeout(() => this.open(onEvent), 2000);
    };
    this.ws.onerror = () => this.ws.close();
    this.ws.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === '__pong') return; // heartbeat echo
      onEvent(ev);
    };
  },
  sendPing() {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ type: '__ping' }));
      setTimeout(() => this.sendPing(), 15000);
    }
  },
  pollClients(show) {
    fetch(this.wsUrl.replace(/^ws/, 'http').replace(/\/$/, '') + '/status')
      .then((r) => r.json())
      .then((s) => {
        this.clients = s.clients;
        if (show) this.updateClientsBadge();
        else this.updateClientsBadge();
      })
      .catch(() => {});
  },
  updateClientsBadge() {
    const el = $('#conn-clients');
    if (this.clients === null) { el.textContent = ''; return; }
    el.textContent = `· ${this.clients} client${this.clients === 1 ? '' : 's'}`;
  },
  close() {
    this.closed = true;
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
  },
};

/* --------------------- Event pipeline (idempotent) ---------------- */

function applyEvent(ev) {
  const { type, data } = ev;
  switch (type) {
    case 'column.created':
    case 'column.updated': upsertColumn(data.column); break;
    case 'column.deleted': removeColumn(data.id); break;
    case 'card.created':
    case 'card.updated':
    case 'card.moved': upsertCard(data.card); break;
    case 'card.deleted': removeCard(data.id); break;
    case 'board.seeded': State.columns = data.columns || []; break;
  }
  renderBoard();
}

function upsertColumn(col) {
  const i = State.columns.findIndex((c) => c.id === col.id);
  if (i === -1) State.columns.push(col);
  else State.columns[i] = col;
  State.columns.sort((a, b) => a.position - b.position);
}

function removeColumn(id) {
  State.columns = State.columns.filter((c) => c.id !== id);
}

function upsertCard(card) {
  removeCard(card.id);
  const col = State.columns.find((c) => c.id === card.column_id);
  if (col) {
    col.cards = col.cards || [];
    col.cards.push(card);
    col.cards.sort((a, b) => a.position - b.position);
  }
}

function removeCard(id) {
  for (const col of State.columns) {
    if (!col.cards) continue;
    col.cards = col.cards.filter((c) => c.id !== id);
  }
}

/* ---------------------------- Rendering --------------------------- */

function renderBoard() {
  if (dragging) { renderQueued = true; return; }

  const board = $('#board');
  const empty = $('#board-empty');
  if (State.columns.length === 0) {
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }

  // Remove columns that disappeared.
  const keep = new Set(State.columns.map((c) => `col-${c.id}`));
  $$('.column').forEach((el) => { if (!keep.has(el.dataset.col)) el.remove(); });

  State.columns.forEach((col) => {
    let el = $(`#col-${col.id}`);
    if (!el) {
      el = document.createElement('section');
      el.className = 'column';
      el.id = `col-${col.id}`;
      el.dataset.col = `col-${col.id}`;
      board.insertBefore(el, board.lastElementChild);
    }
    renderColumn(el, col);
  });
}

function renderColumn(el, col) {
  el.style.setProperty('--accent', col.color || '#3b82f6');
  el.dataset.columnId = col.id;

  const head = el.querySelector('.col-head');
  if (head) head.querySelector('.col-title').textContent = col.title;
  else {
    el.innerHTML = `
      <div class="col-head">
        <h2 class="col-title" title="Double-click to rename"></h2>
        <span class="col-count"></span>
        <button class="btn icon del-col" title="Delete column">✕</button>
      </div>
      <div class="col-body"></div>
      <button class="btn ghost add-card">+ Add card</button>`;
    bindColumnEvents(el);
    el.querySelector('.col-title').textContent = col.title;
  }

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
  node.title = card.note ? card.note : 'Click to edit';
  node.innerHTML = `
    <div class="card-title">${escapeHtml(card.title)}</div>
    ${card.note ? `<div class="card-note">${escapeHtml(card.note)}</div>` : ''}
    <div class="card-meta">#${card.id}${card.updated_at ? ' · ' + timeAgo(card.updated_at) : ''}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function timeAgo(ts) {
  const ms = Date.now() - new Date(ts.replace(' ', 'T') + 'Z').getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return Math.round(s / 3600) + 'h ago';
}

/* ----------------------- Event bindings --------------------------- */

function bindColumnEvents(el) {
  const colId = Number(el.dataset.columnId);

  el.querySelector('.del-col')?.addEventListener('click', () => {
    if (confirm(`Delete column and all its cards?`)) Board.deleteColumn(colId);
  });

  el.querySelector('.col-title')?.addEventListener('dblclick', () => {
    const title = prompt('Rename column', el.querySelector('.col-title').textContent);
    if (title && title.trim()) Board.renameColumn(colId, title.trim());
  });

  el.querySelector('.add-card')?.addEventListener('click', () => {
    openCardEditor(null, colId);
  });

  // ---- drag & drop over the column body ----
  const body = el.querySelector('.col-body');
  body.addEventListener('dragover', (e) => {
    e.preventDefault();
    const cardId = Number(dragSource);
    if (!cardId) return;
    const pos = dropPosition(body, e.clientY, cardId);
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
    const pos = dropPosition(body, e.clientY, cardId);
    Board.moveCard(cardId, colId, pos);
  });
  body.addEventListener('dragleave', () => body.classList.remove('drop-tail'));
}

let dragSource = null;

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
  node.addEventListener('click', () => {
    const card = findCard(Number(node.dataset.cardId));
    if (card) openCardEditor(card, card.column_id);
  });
}

function dropPosition(body, y, excludeCardId) {
  const cards = [...body.querySelectorAll('.card')].filter(
    (n) => Number(n.dataset.cardId) !== excludeCardId
  );
  for (let i = 0; i < cards.length; i++) {
    if (y < cards[i].getBoundingClientRect().top + cards[i].offsetHeight / 2) return i;
  }
  return cards.length;
}

function clearDropMarks() {
  $$('.drop-before, .drop-tail').forEach((el) =>
    el.classList.remove('drop-before', 'drop-tail'));
}

function findCard(id) {
  for (const col of State.columns) {
    const card = (col.cards || []).find((c) => c.id === id);
    if (card) return card;
  }
  return null;
}

/* --------------------------- Editor ------------------------------- */

let editingCard = null;
let editingColumn = null;

function openCardEditor(card, columnId) {
  editingCard = card;
  editingColumn = columnId;
  $('#editor-title').textContent = card ? `Edit card #${card.id}` : 'New card';
  $('#editor-card-title').value = card ? card.title : '';
  $('#editor-card-note').value = card ? (card.note || '') : '';
  $('#btn-delete-card').hidden = !card;
  $('#editor').showModal();
}

$('#btn-save-card')?.addEventListener('click', () => {
  const title = $('#editor-card-title').value.trim();
  if (!title) return;
  const note = $('#editor-card-note').value.trim();
  if (editingCard) Board.updateCard(editingCard.id, title, note);
  else Board.addCard(editingColumn, title, note);
  $('#editor').close();
});

$('#btn-delete-card')?.addEventListener('click', () => {
  if (editingCard && confirm('Delete this card?')) {
    Board.deleteCard(editingCard.id);
    $('#editor').close();
  }
});

/* ------------------------- Settings ------------------------------- */

function openSettings() {
  $$('input[name="transport"]').forEach((r) => {
    r.checked = r.value === Transport.current;
  });
  $('#settings').showModal();
}

$('#btn-apply-settings')?.addEventListener('click', () => {
  const choice = document.querySelector('input[name="transport"]:checked').value;
  if (choice !== Transport.current) {
    Transport.current = choice;
    localStorage.setItem('board.transport', choice);
    startLive();
  }
  $('#settings').close();
});

$('#btn-settings')?.addEventListener('click', openSettings);

/* --------------------------- Feed --------------------------------- */

let feedOpen = false;

function feedEvent(ev) {
  const list = $('#feed-list');
  const li = document.createElement('li');
  const time = new Date().toLocaleTimeString();
  const t = ev.type.replace(/\./g, ' ');
  let detail = '';
  if (ev.data && (ev.data.card || ev.data.column)) {
    detail = escapeHtml((ev.data.card || ev.data.column).title || '');
  }
  li.innerHTML = `<span class="feed-time">${time}</span>
                  <span class="feed-type">${t}</span>
                  <span class="feed-detail">${detail}</span>`;
  list.prepend(li);
  while (list.children.length > 50) list.lastElementChild.remove();
  $('#feed-count').textContent = `last 50 · ${list.children.length} shown`;
}

$('#btn-feed')?.addEventListener('click', () => {
  feedOpen = !feedOpen;
  $('#feed').classList.toggle('hidden', !feedOpen);
  $('#btn-feed').classList.toggle('active', feedOpen);
});

/* --------------------------- Boot --------------------------------- */

async function startLive() {
  if (live) { live.close(); live = null; }
  setConnState(false, 'connecting…');

  const onEvent = (ev) => {
    applyEvent(ev);
    feedEvent(ev);
  };

  live = Transport.current === Transport.ws ? WsTransport : SseTransport;
  live.connect(onEvent);

  // Watchdog: if the transport never opens, say so instead of hanging.
  setTimeout(() => {
    if (live && !transportOpened) {
      setConnState(false, live.name === 'WebSocket'
        ? 'WebSocket unreachable — is board_ws running?'
        : 'SSE not responding');
    }
  }, 6000);
}

let transportOpened = false;

function setConnState(ok, label) {
  transportOpened = transportOpened || ok;
  $('#conn-dot').className = 'dot ' + (ok ? 'ok' : 'bad');
  $('#conn-label').textContent = label;
}

function showBanner(msg) {
  const b = $('#banner');
  if (!b) return;
  b.textContent = msg;
  b.classList.remove('hidden');
}

async function boot() {
  $('#btn-first-col')?.addEventListener('click', async () => {
    const title = prompt('Column title');
    if (title && title.trim()) {
      await Board.addColumn(title.trim(), '#3b82f6');
    }
  });

  $('#btn-seed')?.addEventListener('click', async () => {
    if (confirm('Replace the board with demo data?')) await Board.seed();
  });

  try {
    const res = await Board.get();
    State.columns = res.columns;
  } catch (e) {
    showBanner(`Board failed to load (${e.message}). Is PHP serving /api and is MariaDB running?`);
  }
  renderBoard();
  startLive();

  // Warn when served by the single-threaded built-in PHP server: SSE
  // would block every other request there. Use Apache (or the WS transport).
  const h = await Board.health().catch(() => null);
  if (h && /development server/i.test(h.server || '')) {
    showBanner('You are on the single-threaded `php -S` server — SSE will block requests. ' +
      'Use Apache, or switch to the WebSocket transport in Settings.');
  }
}

document.addEventListener('DOMContentLoaded', boot);
