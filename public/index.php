<?php
declare(strict_types=1);

/**
 * Front controller (Apache / mod_php).
 * - /api/*        -> JSON API + SSE
 * - everything    -> the app (login screen or board UI)
 */

require_once dirname(__DIR__) . '/src/api.php';

$seg = path_segments();
if (($seg[0] ?? '') === 'api') {
    api_dispatch();
}

$base = app_base();
$user = current_user();
$userJson = $user ? json_encode($user) : 'null';

header('Content-Type: text/html; charset=utf-8');
echo <<<HTML
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dockup · Boards</title>
<link rel="stylesheet" href="{$base}/assets/style.css?v=20260816c">
<link rel="icon" href="data:,">
</head>
<body>
<script>try { if (localStorage.getItem('dockup.theme') === 'dark') document.body.classList.add('dark'); } catch (e) {}</script>
<script>window.APP_BASE = "{$base}"; window.CURRENT_USER = {$userJson};</script>

<div id="banner" class="banner hidden"></div>

<!-- ============================== AUTH ============================== -->
<div id="auth-screen" class="auth-screen">
  <div class="auth-card">
    <div class="auth-logo">▦</div>
    <h1>Dockup</h1>
    <p class="auth-sub">Multi-user boards. Realtime. Zero frameworks.</p>

    <form id="login-form" class="auth-form" autocomplete="on">
      <input id="login-user" type="text" placeholder="Username" maxlength="30" required autofocus>
      <input id="login-pass" type="password" placeholder="Password" required>
      <button type="submit" class="btn primary auth-btn">Log in</button>
      <p class="auth-msg" id="login-msg"></p>
      <p class="auth-toggle">New here? <a href="#" id="show-register">Create an account</a></p>
      <p class="auth-demo">Demo account: <code>demo</code> / <code>demo123</code></p>
    </form>

    <form id="register-form" class="auth-form hidden" autocomplete="on">
      <input id="reg-user" type="text" placeholder="Username (3–30 chars)" maxlength="30" required>
      <input id="reg-pass" type="password" placeholder="Password (min 6 chars)" required>
      <button type="submit" class="btn primary auth-btn">Create account</button>
      <p class="auth-msg" id="reg-msg"></p>
      <p class="auth-toggle">Already have an account? <a href="#" id="show-login">Log in</a></p>
    </form>
  </div>
</div>

<!-- ============================ APP SHELL =========================== -->
<div id="app" class="app hidden">

  <header class="topbar">
    <div class="brand">
      <button id="btn-boards" class="btn brand-btn" title="All boards">▦ Dockup</button>
      <span class="crumb" id="board-title"></span>
    </div>
    <div class="topbar-actions">
      <div id="conn" class="conn">
        <span id="conn-dot" class="dot"></span>
        <span id="conn-label">idle</span>
        <span id="conn-clients" class="clients"></span>
      </div>
      <button id="btn-feed" class="btn ghost" title="Toggle live event feed">Feed</button>
      <button id="btn-settings" class="btn ghost" title="Transport settings">Transport</button>
      <button id="theme-toggle" class="btn ghost" title="Toggle dark mode">☾</button>
      <div class="user-menu">
        <span class="avatar" id="avatar"></span>
        <span class="username" id="username"></span>
        <button id="btn-logout" class="btn ghost" title="Log out">⎋</button>
      </div>
    </div>
  </header>

  <!-- ------------------------- boards grid ------------------------- -->
  <main id="view-boards" class="view">
    <div class="view-head">
      <h2>Your boards</h2>
      <button id="btn-new-board" class="btn primary">+ New board</button>
    </div>
    <div id="boards-grid" class="boards-grid"></div>
  </main>

  <!-- -------------------------- board view ------------------------- -->
  <main id="view-board" class="view hidden">
    <div class="board-toolbar">
      <div class="board-actions">
        <button id="btn-add-column" class="btn ghost sm" title="Add a column">+ Add column</button>
        <button id="btn-rename-board" class="btn ghost sm">Rename</button>
        <button id="btn-seed" class="btn ghost sm" title="Add a demo board">Add demo board</button>
      </div>
      <input id="card-search" type="search" placeholder="Filter cards…" autocomplete="off">
      <button id="btn-delete-board" class="btn ghost sm danger" title="Delete board">Delete</button>
    </div>
    <div id="board" class="board" aria-live="polite"></div>
  </main>

  <div id="feed" class="feed hidden">
    <div class="feed-head">
      <span>Live event feed</span>
      <span class="feed-count" id="feed-count">0 events</span>
    </div>
    <ul id="feed-list"></ul>
  </div>

  <!-- ------------------------- card modal -------------------------- -->
  <dialog id="card-modal" class="modal wide">
    <div class="modal-body card-modal-body">
      <div class="cm-head">
        <div class="cm-title-area">
          <h2 id="cm-board-name" class="cm-board"></h2>
          <input id="cm-title" class="cm-title" type="text" maxlength="200" placeholder="Card title">
        </div>
        <button class="btn icon" id="cm-close" title="Close">✕</button>
      </div>

      <div class="cm-grid">
        <div class="cm-main">
          <section class="cm-section">
            <h3>Description <span id="cm-desc-status"></span></h3>
            <div class="editor-toolbar">
              <button data-cmd="bold" title="Bold"><b>B</b></button>
              <button data-cmd="italic" title="Italic"><i>I</i></button>
              <button data-cmd="underline" title="Underline"><u>U</u></button>
              <button data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
              <span class="sep"></span>
              <button data-cmd="insertUnorderedList" title="Bullet list">•≡</button>
              <button data-cmd="insertOrderedList" title="Numbered list">1≡</button>
              <button data-cmd="formatBlock" data-val="H3" title="Heading">H</button>
              <span class="sep"></span>
              <button data-cmd="createLink" title="Link">⛓</button>
              <button data-cmd="removeFormat" title="Clear formatting">⌫</button>
              <button id="cm-save-desc" class="btn primary xs" title="Save description">Save</button>
            </div>
            <div id="cm-desc" class="rich-editor" contenteditable="true"
                 data-placeholder="Add a description…"></div>
          </section>

          <section class="cm-section">
            <h3>Checklist <span id="cm-cl-progress" class="cl-progress"></span></h3>
            <div class="cl-progress-bar"><div id="cm-cl-bar"></div></div>
            <ul id="cm-checklist" class="checklist"></ul>
            <form id="cm-checklist-form" class="inline-add">
              <input id="cm-checklist-input" type="text" maxlength="300" placeholder="Add an item and press Enter">
            </form>
          </section>

          <section class="cm-section">
            <h3>Comments</h3>
            <div id="cm-comments" class="comments"></div>
            <div class="editor-toolbar">
              <button data-cmd="bold"><b>B</b></button>
              <button data-cmd="italic"><i>I</i></button>
              <button data-cmd="strikeThrough"><s>S</s></button>
              <button data-cmd="insertUnorderedList">•≡</button>
              <span class="sep"></span>
              <button type="button" id="cm-comment-attach" title="Attach a file">📎</button>
            </div>
            <div id="cm-comment-input" class="rich-editor comment-input" contenteditable="true"
                 data-placeholder="Write a comment…"></div>
            <input id="cm-comment-file" type="file" class="hidden" accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,text/csv,application/json,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/rtf,application/zip,application/x-zip-compressed,application/gzip,application/x-tar,application/vnd.rar,application/x-rar-compressed,application/x-7z-compressed,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.rtf,.zip,.rar,.7z,.gz,.tar,.csv">
            <div class="cm-foot">
              <button id="cm-save-comment" class="btn primary xs">Post comment</button>
            </div>
          </section>
        </div>

        <aside class="cm-side">
          <section class="cm-section">
            <h3>Add to card</h3>
            <button id="cm-add-label" class="btn ghost sm">🏷 Label</button>
            <button id="cm-attach-btn" class="btn ghost sm">🖼 Attachment</button>
            <input id="cm-attach-file" type="file" class="hidden" accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,text/csv,application/json,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/rtf,application/zip,application/x-zip-compressed,application/gzip,application/x-tar,application/vnd.rar,application/x-rar-compressed,application/x-7z-compressed,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.rtf,.zip,.rar,.7z,.gz,.tar,.csv">
            <label class="cm-field"><span>Due date</span>
              <input id="cm-due" type="date">
            </label>
          </section>

          <section class="cm-section">
            <h3>Labels</h3>
            <div id="cm-labels" class="cm-labels"></div>
          </section>

          <section class="cm-section">
            <h3>Attachments</h3>
            <div id="cm-attachments" class="cm-attachments"></div>
          </section>

          <section class="cm-section">
            <h3>Actions</h3>
            <button id="cm-delete" class="btn danger sm">Delete card</button>
          </section>
        </aside>
      </div>
    </div>
  </dialog>

  <!-- ------------------------- new board --------------------------- -->
  <dialog id="board-modal" class="modal">
    <form method="dialog" class="modal-body">
      <h2>New board</h2>
      <input id="board-modal-title" type="text" maxlength="120" placeholder="Board title" autofocus>
      <div class="theme-palette" id="theme-palette"></div>
      <div class="modal-actions">
        <button value="cancel" class="btn ghost">Cancel</button>
        <button id="btn-create-board" value="default" class="btn primary">Create</button>
      </div>
    </form>
  </dialog>

  <!-- ------------------------ transport ---------------------------- -->
  <dialog id="settings" class="modal">
    <form method="dialog" class="modal-body">
      <h2>Transport settings</h2>
      <p class="hint">How live updates reach this tab.</p>
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

</div>

<script src="{$base}/assets/app.js?v=20260816c"></script>
</body>
</html>
HTML;
