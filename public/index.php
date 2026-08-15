<?php
declare(strict_types=1);

/**
 * Front controller (Apache / mod_php).
 * - /api/*        -> JSON API + SSE
 * - everything    -> the single-page board UI
 */

require_once dirname(__DIR__) . '/src/api.php';

$seg = path_segments();
if (($seg[0] ?? '') === 'api') {
    api_dispatch();
}

$base = app_base();

header('Content-Type: text/html; charset=utf-8');
echo <<<HTML
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Realtime Task Board · PHP + MariaDB + Rust + Vanilla JS</title>
<link rel="stylesheet" href="{$base}/assets/style.css">
<link rel="icon" href="data:,">
</head>
<body>
<script>window.APP_BASE = "{$base}";</script>
  <header class="topbar">
    <div class="brand">
      <span class="logo">▦</span>
      <h1>Realtime Task Board</h1>
      <span class="stack">PHP 8.4 · MariaDB · Rust (std) · Vanilla JS</span>
    </div>
    <div class="topbar-actions">
      <div id="conn" class="conn">
        <span id="conn-dot" class="dot"></span>
        <span id="conn-label">connecting…</span>
        <span id="conn-clients" class="clients"></span>
      </div>
      <button id="btn-seed" class="btn ghost" title="Reset board to demo data">Reset demo</button>
      <button id="btn-feed" class="btn ghost" title="Toggle live event feed">Live feed</button>
      <button id="btn-settings" class="btn ghost" title="Transport settings">Settings</button>
    </div>
  </header>

  <div id="banner" class="banner hidden"></div>

  <main id="board" class="board" aria-live="polite">
    <div id="board-empty" class="board-empty">
      <p>No columns yet.</p>
      <button id="btn-first-col" class="btn primary">Add a column</button>
    </div>
  </main>

  <div id="feed" class="feed hidden">
    <div class="feed-head">
      <span>Live event feed</span>
      <span class="feed-count" id="feed-count">0 events</span>
    </div>
    <ul id="feed-list"></ul>
  </div>

  <dialog id="settings" class="modal">
    <form method="dialog" class="modal-body">
      <h2>Transport settings</h2>
      <p class="hint">Choose how live updates reach this tab. Everything else
      works the same — same events, same board.</p>
      <label class="radio">
        <input type="radio" name="transport" value="sse">
        <span><b>Server-Sent Events</b> <small>PHP long-poll over MariaDB</small></span>
      </label>
      <label class="radio">
        <input type="radio" name="transport" value="ws">
        <span><b>WebSocket</b> <small>Rust broadcast server (pure std)</small></span>
      </label>
      <div class="modal-actions">
        <button value="cancel" class="btn ghost">Cancel</button>
        <button id="btn-apply-settings" value="default" class="btn primary">Apply</button>
      </div>
    </form>
  </dialog>

  <dialog id="editor" class="modal">
    <form method="dialog" class="modal-body">
      <h2 id="editor-title">Card</h2>
      <input id="editor-card-title" type="text" maxlength="200" placeholder="Title" autocomplete="off">
      <textarea id="editor-card-note" rows="4" maxlength="4000" placeholder="Notes (optional)"></textarea>
      <div class="modal-actions">
        <button value="cancel" class="btn ghost">Cancel</button>
        <button id="btn-delete-card" value="default" class="btn danger">Delete</button>
        <button id="btn-save-card" value="default" class="btn primary">Save</button>
      </div>
    </form>
  </dialog>

  <script src="{$base}/assets/app.js"></script>
</body>
</html>
HTML;