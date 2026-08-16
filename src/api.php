<?php
declare(strict_types=1);

/**
 * API front controller. Routes live under /api/*
 * Plain PHP: method + path segments, PDO for data, no framework.
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/board.php';
require_once __DIR__ . '/events.php';
require_once __DIR__ . '/sanitize.php';

function api_dispatch(): void
{
    $seg = path_segments();
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    /* ---------------------------- auth ---------------------------- */

    if ($seg === ['api', 'auth', 'register'] && $method === 'POST') {
        guard_mutation();
        $data = body();
        send_json(['ok' => true, 'user' => auth_register(require_str($data, 'username', 30), (string) ($data['password'] ?? ''))], 201);
    }
    if ($seg === ['api', 'auth', 'login'] && $method === 'POST') {
        guard_mutation();
        $data = body();
        $user = auth_login(require_str($data, 'username', 30), (string) ($data['password'] ?? ''));
        $user ? send_json(['ok' => true, 'user' => $user])
              : send_error('Wrong username or password', 401);
    }
    if ($seg === ['api', 'auth', 'logout'] && $method === 'POST') {
        guard_mutation();
        auth_logout();
        send_json(['ok' => true]);
    }
    if ($seg === ['api', 'auth', 'me']) {
        $user = current_user();
        send_json(['ok' => true, 'authed' => $user !== null, 'user' => $user]);
    }

    /* ---------------------------- health --------------------------- */

    if ($method === 'GET' && $seg === ['api', 'health']) {
        ws_ensure_running(); // boot the Rust server on demand if it is down
        $ws = @fsockopen(config()['ws']['host'], config()['ws']['port'], $ec, $es, 0.4);
        $host = $_SERVER['HTTP_HOST'] ?? null;
        if ($host !== null) {
            $parsed = parse_url('http://' . $host);
            $host = $parsed['host'] ?? config()['ws']['host'];
        }
        if ($host === null || !preg_match('/^[a-z0-9.-]+$/i', $host)) {
            $host = config()['ws']['host'];
        }
        send_json([
            'ok'     => true,
            'time'   => date(DATE_ATOM),
            'ws'     => $ws ? 'up' : 'down',
            'wsUrl'  => sprintf('ws://%s:%d/', $host ?? config()['ws']['host'], config()['ws']['port']),
            'server' => $_SERVER['SERVER_SOFTWARE'] ?? 'unknown',
        ]);
        if ($ws) { fclose($ws); }
    }

    /* ---------------- everything below needs a session -------------- */

    $user = require_auth();
    $userId = (int) $user['id'];

    /* ---------------------------- boards --------------------------- */

    if ($method === 'GET' && $seg === ['api', 'boards']) {
        send_json(['ok' => true, 'boards' => user_boards($userId)]);
    }

    if ($method === 'POST' && $seg === ['api', 'boards']) {
        guard_mutation();
        $data = body();
        $board = create_board($userId, require_str($data, 'title', 120), (string) opt_str($data, 'theme', '#0b6e4f', 7));
        record_event('board.created', (int) $board['id'], ['board' => $board]);
        send_json(['ok' => true, 'board' => $board], 201);
    }

    if (($seg[0] ?? '') === 'api' && ($seg[1] ?? '') === 'boards' && isset($seg[2])) {
        $boardId = (int) $seg[2];

        if ($method === 'GET' && count($seg) === 3) {
            $snap = board_snapshot($boardId, $userId);
            $snap ? send_json(['ok' => true] + $snap) : send_error('Board not found', 404);
        }
        if ($method === 'PUT' && count($seg) === 3) {
            guard_mutation();
            $data = body();
            $board = update_board($boardId, $userId, opt_str($data, 'title', null, 120), opt_str($data, 'theme', null, 7));
            if ($board) {
                record_event('board.updated', $boardId, ['board' => $board]);
                send_json(['ok' => true, 'board' => $board]);
            }
            send_error('Board not found', 404);
        }
        if ($method === 'DELETE' && count($seg) === 3) {
            guard_mutation();
            if (delete_board($boardId, $userId)) {
                record_event('board.deleted', $boardId, ['id' => $boardId]);
                send_json(['ok' => true]);
            }
            send_error('Board not found', 404);
        }
        if ($method === 'POST' && ($seg[3] ?? '') === 'columns') {
            guard_mutation();
            if (board_owned($boardId, $userId) === null) { send_error('Board not found', 404); }
            $data = body();
            $col = create_column($boardId, require_str($data, 'title', 120));
            record_event('column.created', $boardId, ['column' => $col]);
            send_json(['ok' => true, 'column' => $col], 201);
        }
    }

    /* --------------------------- columns --------------------------- */

    if (($seg[0] ?? '') === 'api' && ($seg[1] ?? '') === 'columns' && isset($seg[2])) {
        $columnId = (int) $seg[2];
        $owned = column_owned($columnId, $userId);
        $boardId = $owned ? (int) $owned['board_id'] : 0;

        if ($method === 'PUT') {
            guard_mutation();
            $data = body();
            $col = update_column($columnId, require_str($data, 'title', 120));
            if ($col) {
                record_event('column.updated', $boardId, ['column' => $col]);
                send_json(['ok' => true, 'column' => $col]);
            }
            send_error('Column not found', 404);
        }
        if ($method === 'DELETE') {
            guard_mutation();
            if (delete_column($columnId)) {
                record_event('column.deleted', $boardId, ['id' => $columnId]);
                send_json(['ok' => true]);
            }
            send_error('Column not found', 404);
        }
        if ($method === 'POST' && ($seg[3] ?? '') === 'move') {
            guard_mutation();
            $data = body();
            $col = move_column($columnId, max(0, (int) ($data['position'] ?? 0)));
            if ($col) {
                record_event('column.moved', $boardId, ['column' => $col]);
                send_json(['ok' => true, 'column' => $col]);
            }
            send_error('Column not found', 404);
        }
        if ($method === 'POST' && ($seg[3] ?? '') === 'cards') {
            guard_mutation();
            $data = body();
            $card = create_card($columnId, require_str($data, 'title', 200), opt_str($data, 'description', ''), opt_str($data, 'dueDate', null, 10));
            if ($card) {
                record_event('card.created', $boardId, ['card' => $card]);
                send_json(['ok' => true, 'card' => $card], 201);
            }
            send_error('Column not found', 404);
        }
    }

    /* ----------------------------- cards --------------------------- */

    if (($seg[0] ?? '') === 'api' && ($seg[1] ?? '') === 'cards' && isset($seg[2])) {
        $cardId = (int) $seg[2];
        $owned = card_owned($cardId, $userId);
        $boardId = $owned ? board_id_of_card($cardId) : 0;
        $action = $seg[3] ?? null;

        if ($method === 'GET' && $action === null) {
            $detail = card_detail($cardId);
            $detail ? send_json(['ok' => true, 'card' => $detail]) : send_error('Card not found', 404);
        }
        if ($method === 'PUT' && $action === null) {
            guard_mutation();
            $data = body();
            $card = update_card($cardId, opt_str($data, 'title', null, 200), opt_str($data, 'description', null), opt_str($data, 'dueDate', null, 10));
            if ($card) {
                record_event('card.updated', $boardId, ['card' => $card]);
                send_json(['ok' => true, 'card' => $card]);
            }
            send_error('Card not found', 404);
        }
        if ($method === 'DELETE' && $action === null) {
            guard_mutation();
            if (delete_card($cardId)) {
                record_event('card.deleted', $boardId, ['id' => $cardId]);
                send_json(['ok' => true]);
            }
            send_error('Card not found', 404);
        }
        if ($method === 'POST' && $action === 'move') {
            guard_mutation();
            $data = body();
            $card = move_card($cardId, (int) ($data['columnId'] ?? 0), max(0, (int) ($data['position'] ?? 0)));
            if ($card) {
                record_event('card.moved', $boardId, ['card' => $card]);
                send_json(['ok' => true, 'card' => $card]);
            }
            send_error('Card or column not found', 404);
        }

        // ---- sub-resources ----
        if ($method === 'POST' && $action === 'labels') {
            guard_mutation();
            $data = body();
            $label = add_label($cardId, (string) opt_str($data, 'text', ''), (string) opt_str($data, 'color', '#3b82f6', 7));
            if ($label) {
                record_event('label.created', $boardId, ['label' => $label, 'cardId' => $cardId]);
                send_json(['ok' => true, 'label' => $label], 201);
            }
            send_error('Card not found', 404);
        }
        if ($method === 'POST' && $action === 'checklist') {
            guard_mutation();
            $data = body();
            $item = add_checklist_item($cardId, require_str($data, 'text', 300));
            if ($item) {
                record_event('checklist.created', $boardId, ['item' => $item, 'cardId' => $cardId]);
                send_json(['ok' => true, 'item' => $item], 201);
            }
            send_error('Card not found', 404);
        }
        if ($method === 'POST' && $action === 'comments') {
            guard_mutation();
            $data = body();
            // php://input is empty for multipart uploads; the text fields
            // land in $_POST instead.
            $bodyHtml = isset($_POST['body']) ? (string) $_POST['body'] : (string) opt_str($data, 'body', '', 20000);
            $file = $_FILES['file'] ?? null;
            if (is_array($file)) {
                $res = add_comment_upload($cardId, $userId, $bodyHtml, $file);
                if ($res) {
                    record_event('comment.created', $boardId, ['comment' => $res['comment']]);
                    if ($res['attachment']) {
                        record_event('attachment.created', $boardId, ['attachment' => $res['attachment']]);
                    }
                    send_json(['ok' => true] + $res, 201);
                }
                send_error('Comment empty or card not found', 422);
            }
            $comment = add_comment($cardId, $userId, $bodyHtml);
            if ($comment) {
                record_event('comment.created', $boardId, ['comment' => $comment]);
                send_json(['ok' => true, 'comment' => $comment], 201);
            }
            send_error('Comment empty or card not found', 422);
        }
        if ($method === 'POST' && $action === 'attachments') {
            guard_mutation();
            $file = $_FILES['file'] ?? null;
            if (!is_array($file)) { send_error('Missing file field', 422); }
            $att = store_attachment($cardId, $userId, $file);
            if ($att) {
                record_event('attachment.created', $boardId, ['attachment' => $att]);
                send_json(['ok' => true, 'attachment' => $att], 201);
            }
            send_error('Card not found', 404);
        }
    }

    /* ----------------------- card sub-resources -------------------- */

    if ($seg[0] === 'api' && $seg[1] === 'labels' && isset($seg[2])) {
        if ($method === 'DELETE') {
            guard_mutation();
            $label = db()->prepare('SELECT l.*, bc.board_id FROM card_labels l
                JOIN cards c ON c.id = l.card_id JOIN board_columns bc ON bc.id = c.column_id WHERE l.id = ?');
            $label->execute([(int) $seg[2]]);
            $row = $label->fetch();
            if (delete_label((int) $seg[2]) && $row) {
                record_event('label.deleted', (int) $row['board_id'],
                    ['id' => (int) $seg[2], 'cardId' => (int) $row['card_id']]);
                send_json(['ok' => true]);
            }
            send_error('Label not found', 404);
        }
    }
    if ($seg[0] === 'api' && $seg[1] === 'checklist' && isset($seg[2])) {
        $itemId = (int) $seg[2];
        $item = db()->prepare('SELECT ci.*, bc.board_id FROM checklist_items ci
            JOIN cards c ON c.id = ci.card_id JOIN board_columns bc ON bc.id = c.column_id WHERE ci.id = ?');
        $item->execute([$itemId]);
        $row = $item->fetch();
        $boardId = $row ? (int) $row['board_id'] : 0;

        if ($method === 'PUT') {
            guard_mutation();
            $data = body();
            $updated = update_checklist_item($itemId, opt_str($data, 'text', null, 300),
                array_key_exists('checked', $data) ? (bool) $data['checked'] : null);
            if ($updated) {
                record_event('checklist.updated', $boardId, ['item' => $updated]);
                send_json(['ok' => true, 'item' => $updated]);
            }
            send_error('Item not found', 404);
        }
        if ($method === 'DELETE') {
            guard_mutation();
            if (delete_checklist_item($itemId)) {
                record_event('checklist.deleted', $boardId, ['id' => $itemId, 'cardId' => (int) $row['card_id']]);
                send_json(['ok' => true]);
            }
            send_error('Item not found', 404);
        }
    }
    if ($seg[0] === 'api' && $seg[1] === 'comments' && isset($seg[2]) && $method === 'DELETE') {
        guard_mutation();
        $comment = db()->prepare('SELECT cm.*, bc.board_id FROM comments cm
            JOIN cards c ON c.id = cm.card_id JOIN board_columns bc ON bc.id = c.column_id WHERE cm.id = ?');
        $comment->execute([(int) $seg[2]]);
        $row = $comment->fetch();
        if (delete_comment((int) $seg[2], $userId) && $row) {
            record_event('comment.deleted', (int) $row['board_id'],
                ['id' => (int) $seg[2], 'cardId' => (int) $row['card_id']]);
            send_json(['ok' => true]);
        }
        send_error('Comment not found', 404);
    }
    if ($seg[0] === 'api' && $seg[1] === 'attachments' && isset($seg[2]) && $method === 'DELETE') {
        guard_mutation();
        $att = db()->prepare('SELECT a.*, bc.board_id FROM attachments a
            JOIN cards c ON c.id = a.card_id JOIN board_columns bc ON bc.id = c.column_id WHERE a.id = ?');
        $att->execute([(int) $seg[2]]);
        $row = $att->fetch();
        $boardId = $row ? (int) $row['board_id'] : 0;
        if (delete_attachment((int) $seg[2], $userId) && $row) {
            record_event('attachment.deleted', $boardId,
                ['id' => (int) $seg[2], 'cardId' => (int) $row['card_id']]);
            send_json(['ok' => true]);
        }
        send_error('Attachment not found', 404);
    }

    /* ------------------------------ SSE ---------------------------- */

    if ($method === 'GET' && $seg === ['api', 'events']) {
        $boardId = max(0, (int) ($_GET['board'] ?? 0));
        if ($boardId > 0 && board_owned($boardId, $userId) === null) {
            send_error('Board not found', 404);
        }
        sse_stream($boardId);
    }

    /* ------------------------------ seed --------------------------- */

    if ($method === 'POST' && $seg === ['api', 'seed']) {
        guard_mutation();
        seed_user_board($userId);
        send_json(['ok' => true, 'boards' => user_boards($userId)]);
    }

    send_error('Not found', 404);
}

/**
 * Create a fresh demo board for the current user.
 */
function seed_user_board(int $userId): void
{
    $stmt = db()->prepare('INSERT INTO boards (user_id, title, theme) VALUES (?, ?, ?)');
    $stmt->execute([$userId, 'Demo board', '#0b6e4f']);
    $boardId = (int) db()->lastInsertId();

    $cols = [
        ['To do', ['Plan the clone', 'Sketch the schema', 'Pick the stack (PHP · MariaDB · Rust · vanilla JS)']],
        ['Doing', ['Build the realtime core', 'Drag & drop cards']],
        ['Done', ['Zero frameworks, zero libraries']],
    ];
    foreach ($cols as $i => [$title, $cards]) {
        db()->prepare('INSERT INTO board_columns (board_id, title, position) VALUES (?, ?, ?)')
            ->execute([$boardId, $title, $i]);
        $colId = (int) db()->lastInsertId();
        foreach ($cards as $j => $cardTitle) {
            db()->prepare('INSERT INTO cards (column_id, title, position, description_html) VALUES (?, ?, ?, ?)')
                ->execute([$colId, $cardTitle, $j, '<p>Write it once, sync it everywhere.</p>']);
        }
    }

    record_event('board.seeded', $boardId, ['board' => ['id' => $boardId, 'title' => 'Demo board']]);
}

/**
 * Server-Sent Events stream, scoped to one board.
 * Long-lived GET replaying events newer than Last-Event-ID by polling the
 * `events` table. Requires a multi-process server (Apache / php-fpm).
 */
function sse_stream(int $boardId): void
{
    // The session is only needed to authenticate; holding it would lock the
    // session file for the entire stream and block every other request from
    // the same browser session.
    if (function_exists('session_write_close')) {
        session_write_close();
    }
    if (function_exists('set_time_limit')) {
        set_time_limit(0);
    }
    if (function_exists('ignore_user_abort')) {
        ignore_user_abort(true);
    }

    header('Content-Type: text/event-stream; charset=utf-8');
    header('Cache-Control: no-cache, no-transform');
    header('Connection: keep-alive');
    header('X-Accel-Buffering: no');

    while (ob_get_level() > 0) {
        ob_end_flush();
    }
    ob_implicit_flush(true);

    // Instant comment frame so clients know the stream is alive.
    echo ": connected\n\n";
    flush();

    // Fresh connects (no Last-Event-ID) must not replay the full history:
    // the board snapshot already carries the current state, and replaying
    // old column.created / card.created events would resurrect entities
    // that have since been deleted. Only replay the last 15 seconds to
    // cover the snapshot -> connect race. Reconnecting clients keep the
    // normal id-based replay.
    $lastId = isset($_SERVER['HTTP_LAST_EVENT_ID']) ? max(0, (int) $_SERVER['HTTP_LAST_EVENT_ID']) : 0;
    if ($lastId === 0) {
        // Compute the cutoff inside MariaDB so we don't mix PHP/MariaDB
        // timezones (they differ on this box).
        $stmt = db()->prepare('SELECT id, payload FROM events WHERE id > ? AND board_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 15 SECOND) ORDER BY id LIMIT 50');
        $args = [$lastId, $boardId];
    } else {
        $stmt = db()->prepare('SELECT id, payload FROM events WHERE id > ? AND board_id = ? ORDER BY id LIMIT 50');
        $args = [$lastId, $boardId];
    }
    $stmt->execute($args);

    $heartbeat = 0;
    while (true) {
        if (connection_aborted()) {
            exit;
        }
        $stmt->execute($args);
        while ($row = $stmt->fetch()) {
            $lastId = (int) $row['id'];
            echo 'id: ', $lastId, "\n";
            echo 'data: ', $row['payload'], "\n\n";
        }
        flush();

        if (time() - $heartbeat >= 15) {
            $heartbeat = time();
            echo ": ping\n\n";
            flush();
        }
        usleep(250_000);
    }
}
