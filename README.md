# Dockup — Realtime Multi-User Boards (Trello-style clone)

A Trello-style kanban clone with accounts, multiple boards per user, rich
text, checklists, labels, comments and picture uploads — all syncing live
across tabs and browsers.

**Zero frameworks, zero libraries** — only the core languages:

| Layer    | Tech                                                        |
|----------|-------------------------------------------------------------|
| Frontend | Vanilla JS (ES2020), HTML, CSS — drag & drop, two live transports |
| Backend  | Core PHP 8.4, PDO, sessions, no framework                   |
| Storage  | MariaDB (InnoDB, utf8mb4)                                   |
| Realtime | **Two transports, user-selectable in Settings**:            |
|          | • **SSE** — PHP long-poll streaming over the `events` table |
|          | • **WebSocket** — a Rust broadcast server built on **pure `std`** (hand-rolled RFC 6455 frames, SHA-1 and base64 — zero crates) |

Every mutation is written once and fanned out to **both** transports, so
whatever you pick in Settings, every connected tab sees the same events —
scoped to the board you are viewing.

---

## Architecture

```
                 ┌──────────────────────────────────────────────┐
                 │              MariaDB                          │
                 │  users · boards · columns · cards · events    │
                 └──────────────────────────────────────────────┘
                        ▲                          ▲
        writes + reads  │                          │ reads (SSE poll)
        ┌───────────────┴──────────┐               │
        │  PHP 8.4 (REST + SSE)    │               │
        └───────┬──────────────────┘               │
                │ POST /broadcast (event JSON)     │  GET /api/events?board=ID
        ┌───────┴───────────────┐                  │
        │ Rust WS broadcast     │◄─────────────────┘
        │ (pure std, :9001)     │   WebSocket frames
        └───────┬───────────────┘
                │ frames
        ┌───────┴─────┐   ┌──────────┐   ┌──────────┐
        │ Browser tab │   │ Browser  │   │ Browser  │  …N tabs, all live
        └─────────────┘   └──────────┘   └──────────┘
```

* **SSE path** — PHP inserts the event into `events`, SSE readers poll
  `events` with `Last-Event-ID` and stream it as `text/event-stream`.
  The session lock is released as soon as the stream starts so the same
  browser session can keep making requests.
* **WS path** — PHP POSTs the same event to the Rust server, which
  fan-outs a WebSocket text frame to every connected client.

---

## Run it

### 1. Database (MariaDB)

The app **auto-creates** the database, tables and a demo user on first
request — nothing to run. Schema is versioned in `src/db.php`
(`SCHEMA_VERSION`); older versions are dropped and reseeded automatically.

Defaults: `root` / no password on `127.0.0.1:3306`, database `dockerup_board`.
Override with env vars: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME`.

First-run demo account: **`demo` / `demo123`** (+ a seeded "Welcome board").

### 2. Rust realtime server

```sh
cd server
cargo run --release            # binds 0.0.0.0:9001
# or a different port:  cargo run --release -- 9002
```

Set `WS_HOST` / `WS_PORT` in the PHP environment if you change the port.

### 3. PHP app

Serve `public/` with any web server.

**Apache (recommended — SSE needs a multi-process server):**

```
DocumentRoot /path/to/test-repo/public
```

Or drop the folder under `www/` and visit `http://localhost/dockerup/public/`.

**Quick dev server** (WebSocket transport works; SSE is single-threaded
on `php -S` and will serialize requests — use Apache for SSE):

```sh
php -S 127.0.0.1:8080 -t public public/router.php
```

> ⚠️ SSE on `php -S` (built-in server) will block other requests because
> it is single-threaded — the page will hang. Use **Apache** (or the
> WebSocket transport, which works fine anywhere). The app shows a warning
> banner when it detects the built-in server.

Then log in, open a board, open a **second tab**, and watch it sync.

---

## Features

- **Accounts**: register / login / logout (PHP sessions, `password_hash`)
- **Boards**: each user has their own boards — create, rename, theme color,
  delete (cascades to everything on the board)
- **Columns**: add, rename (double-click title), delete, drag to reorder
- **Cards**: add, edit, delete; **drag & drop** between and within columns
  (native HTML5 DnD)
- **Rich text description**: contenteditable + toolbar (bold, italic,
  underline, strikethrough, lists, headings, links) — sanitized server-side
  by an allowlist HTML sanitizer (DOMDocument)
- **Labels** (colored chips), **checklist** with progress bar, **due dates**
  (overdue highlighting)
- **Comments** (rich text, delete your own)
- **Attachments**: image previews (PNG/JPEG/GIF/WebP) + PDF/txt/json,
  5 MB cap, MIME sniffed with `finfo`
- **Live sync** across tabs/browsers via SSE **or** WebSocket —
  switchable in *Settings* without reloading the page
- Live event feed panel showing every mutation as it happens
- Connection status indicator + connected-client count (WS)
- Auto-reconnect on both transports; event catch-up after a tab reconnects
- `Add demo board` seeds a sample board so you can play immediately
- CSRF protection: state-changing requests must be same-origin
  (Origin / Sec-Fetch-Site check)

## Tests

```
node test/api-v2-test.js         # full API: auth, CRUD, sanitizer, uploads, SSE
node test/browser-e2e-test.js    # real Edge headless via CDP: login, boards,
                                 # card modal, comments, checklist, labels,
                                 # upload, realtime over SSE **and** WS
php test/sanitize-test.php       # HTML sanitizer unit tests
```

Requirements: Apache + MariaDB running, Rust `board_ws` on :9001,
`dockerup_board` database reachable (port 3307 in this dev environment).

## Rust server API

| Endpoint | Purpose |
|----------|---------|
| `GET /` (Upgrade: websocket) | realtime client connection |
| `POST /broadcast` | body JSON is fanned out to every WS client (used by PHP) |
| `GET /status` | `{"clients": n, "uptime": s}` |

The Rust binary contains no external crates: SHA-1 (RFC 3174), base64,
and the WebSocket frame codec (RFC 6455) are implemented by hand in
`server/src/main.rs`.

## API overview

```sh
# auth
curl -X POST http://localhost/api/auth/register -H "Content-Type: application/json" -d '{"username":"me","password":"secret1"}'
curl -X POST http://localhost/api/auth/login    -H "Content-Type: application/json" -d '{"username":"demo","password":"demo123"}'

# boards / columns / cards
curl http://localhost/api/boards
curl -X POST http://localhost/api/boards -H "Content-Type: application/json" -d '{"title":"My board","theme":"#3b82f6"}'
curl -X POST http://localhost/api/boards/1/columns -H "Content-Type: application/json" -d '{"title":"Backlog"}'
curl -X POST http://localhost/api/columns/1/cards  -H "Content-Type: application/json" -d '{"title":"Ship it"}'
curl -X POST http://localhost/api/cards/1/move     -H "Content-Type: application/json" -d '{"columnId":2,"position":0}'

# card extras
curl -X POST http://localhost/api/cards/1/comments    -H "Content-Type: application/json" -d '{"body":"<b>nice</b>"}'
curl -X POST http://localhost/api/cards/1/checklist   -H "Content-Type: application/json" -d '{"text":"buy milk"}'
curl -X POST http://localhost/api/cards/1/labels      -H "Content-Type: application/json" -d '{"text":"bug","color":"#ef4444"}'
curl -X POST http://localhost/api/cards/1/attachments -F "file=@pixel.png"

# realtime
curl -N "http://localhost/api/events?board=1"   # SSE stream (authenticated)
```

All mutations also reach WebSocket clients via the Rust server.
