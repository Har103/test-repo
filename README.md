# Realtime Task Board

A kanban-style board that syncs live across every open tab or browser.

**Zero frameworks, zero libraries** — only the core languages:

| Layer    | Tech                                                        |
|----------|-------------------------------------------------------------|
| Frontend | Vanilla JS (ES2020), HTML, CSS — drag & drop, two live transports |
| Backend  | Core PHP 8.4, PDO, no framework                             |
| Storage  | MariaDB (InnoDB, utf8mb4)                                   |
| Realtime | **Two transports, user-selectable in Settings**:            |
|          | • **SSE** — PHP long-poll streaming over the `events` table |
|          | • **WebSocket** — a Rust broadcast server built on **pure `std`** (hand-rolled RFC 6455 frames, SHA-1 and base64 — zero crates) |

Every mutation is written once and fanned out to **both** transports, so
whatever you pick in Settings, every connected tab sees the same events.

---

## Architecture

```
                 ┌──────────────────────────────────────────────┐
                 │              MariaDB                          │
                 │  board_columns · cards · events               │
                 └──────────────────────────────────────────────┘
                        ▲                          ▲
        writes + reads  │                          │ reads (SSE poll)
        ┌───────────────┴──────────┐               │
        │  PHP 8.4 (REST + SSE)    │               │
        └───────┬──────────────────┘               │
                │ POST /broadcast (event JSON)     │  GET /api/events
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
* **WS path** — PHP POSTs the same event to the Rust server, which
  fan-outs a WebSocket text frame to every connected client.

---

## Run it

### 1. Database (MariaDB)

The app **auto-creates** the database and tables on first request —
nothing to run. For manual setup:

```sql
SOURCE db/schema.sql;   -- or run it in phpMyAdmin / HeidiSQL
```

Defaults: `root` / no password on `127.0.0.1:3306`, database `dockerup_board`.
Override with env vars: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME`.

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
> it is single-threaded. For the SSE transport use Apache / php-fpm.
> The WebSocket transport works fine anywhere.

Then open the board, open a **second tab**, and watch it sync.

## Tests

```
test/ws-e2e-test.js       # raw WS clients + HTTP broadcast fan-out
test/ws-php-loop-test.js  # PHP API mutation -> Rust -> WS client
test/sse-test.js          # SSE stream + API mutations (needs 2 servers)
test/apache-e2e-test.js   # SSE + WS simultaneously on one Apache server
```

---

## Features

- Columns: add, rename (double-click title), delete
- Cards: add, edit (click), delete, notes
- **Drag & drop** cards between and within columns (native HTML5 DnD)
- **Live sync** across tabs/browsers via SSE **or** WebSocket —
  switchable in *Settings* without reloading the page
- Live event feed panel showing every mutation as it happens
- Connection status indicator + connected-client count (WS)
- Auto-reconnect on both transports; event catch-up after a tab reconnects
- `Reset demo` seeds a sample board so you can play immediately
- API: `GET /api/board`, `POST /api/seed`, `GET /api/health`, CRUD under
  `/api/columns`, `/api/cards`, plus `GET /api/events` (SSE stream)

## Rust server API

| Endpoint | Purpose |
|----------|---------|
| `GET /` (Upgrade: websocket) | realtime client connection |
| `POST /broadcast` | body JSON is fanned out to every WS client (used by PHP) |
| `GET /status` | `{"clients": n, "uptime": s}` |

The Rust binary contains no external crates: SHA-1 (RFC 3174), base64,
and the WebSocket frame codec (RFC 6455) are implemented by hand in
`server/src/main.rs`.

## API examples

```sh
curl http://localhost/api/board
curl -X POST http://localhost/api/columns -H "Content-Type: application/json" -d '{"title":"Backlog"}'
curl -X POST http://localhost/api/cards -H "Content-Type: application/json" -d '{"columnId":1,"title":"Ship it","note":"soon"}'
curl -X POST http://localhost/api/cards/1/move -H "Content-Type: application/json" -d '{"columnId":2,"position":0}'
curl -N http://localhost/api/events          # SSE stream
```
