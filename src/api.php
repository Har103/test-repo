<?php
declare(strict_types=1);

/**
 * API front controller. Routes live under /api/*
 * Plain PHP: switch on method + path segments, PDO for data.
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/board.php';
require_once __DIR__ . '/events.php';

function api_dispatch(): void
{
    $seg = path_segments();
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    // GET /api/board
    if ($method === 'GET' && $seg === ['api', 'board']) {
        send_json(['ok' => true, 'columns' => board_snapshot()]);
    }

    // GET /api/health
    if ($method === 'GET' && $seg === ['api', 'health']) {
        $ws = @fsockopen(config()['ws']['host'], config()['ws']['port'], $ec, $es, 0.4);

        // Derive the WS address from the request host so the browser
        // reaches the Rust server from anywhere (localhost, LAN IP,
        // or a real domain like app.dockup.ai), not just 127.0.0.1.
        $host = $_SERVER['HTTP_HOST'] ?? null;
        if ($host !== null) {
            $parsed = parse_url('http://' . $host);
            $host = $parsed['host'] ?? config()['ws']['host'];
        }
        $wsPort = config()['ws']['port'];

        send_json([
            'ok'     => true,
            'time'   => date(DATE_ATOM),
            'ws'     => $ws ? 'up' : 'down',
            'wsUrl'  => sprintf('ws://%s:%d/', $host ?? config()['ws']['host'], $wsPort),
            'server' => $_SERVER['SERVER_SOFTWARE'] ?? 'unknown',
        ]);
        if ($ws) { fclose($ws); }
    }

    // GET /api/events  -> Server-Sent Events stream
    if ($method === 'GET' && $seg === ['api', 'events']) {
        sse_stream();
    }

    // POST /api/seed
    if ($method === 'POST' && $seg === ['api', 'seed']) {
        seed_demo();
        record_event('board.seeded', ['columns' => board_snapshot()]);
        send_json(['ok' => true, 'columns' => board_snapshot()]);
    }

    // ---- columns -----------------------------------------------------
    if (($seg[0] ?? '') === 'api' && ($seg[1] ?? '') === 'columns') {
        $id = isset($seg[2]) ? (int) $seg[2] : null;

        if ($method === 'POST' && $id === null) {
            $data = body();
            $title = require_str($data, 'title', 120);
            $color = (string) opt_str($data, 'color', '#3b82f6', 7);
            send_json(['ok' => true, 'column' => create_column($title, $color)], 201);
        }
        if ($method === 'PUT' && $id !== null) {
            $data = body();
            $title = require_str($data, 'title', 120);
            $color = opt_str($data, 'color', null, 7);
            $column = update_column($id, $title, $color);
            $column ? send_json(['ok' => true, 'column' => $column])
                    : send_error('Column not found', 404);
        }
        if ($method === 'DELETE' && $id !== null) {
            delete_column($id)
                ? send_json(['ok' => true])
                : send_error('Column not found', 404);
        }
    }

    // ---- cards -------------------------------------------------------
    if (($seg[0] ?? '') === 'api' && ($seg[1] ?? '') === 'cards') {
        $id = isset($seg[2]) ? (int) $seg[2] : null;
        $action = $seg[3] ?? null;

        if ($method === 'POST' && $id === null) {
            $data = body();
            $columnId = (int) ($data['columnId'] ?? 0);
            if ($columnId <= 0) { send_error('Missing columnId'); }
            $title = require_str($data, 'title', 200);
            $note = opt_str($data, 'note', '');
            $card = create_card($columnId, $title, $note);
            $card ? send_json(['ok' => true, 'card' => $card], 201)
                  : send_error('Column not found', 404);
        }
        if ($method === 'POST' && $id !== null && $action === 'move') {
            $data = body();
            $columnId = (int) ($data['columnId'] ?? 0);
            $position = max(0, (int) ($data['position'] ?? 0));
            if ($columnId <= 0) { send_error('Missing columnId'); }
            $card = move_card($id, $columnId, $position);
            $card ? send_json(['ok' => true, 'card' => $card])
                  : send_error('Card or column not found', 404);
        }
        if ($method === 'PUT' && $id !== null && $action === null) {
            $data = body();
            $title = require_str($data, 'title', 200);
            $note = opt_str($data, 'note', '');
            $card = update_card($id, $title, $note);
            $card ? send_json(['ok' => true, 'card' => $card])
                  : send_error('Card not found', 404);
        }
        if ($method === 'DELETE' && $id !== null) {
            delete_card($id)
                ? send_json(['ok' => true])
                : send_error('Card not found', 404);
        }
    }

    send_error('Not found', 404);
}

/**
 * Server-Sent Events stream.
 *
 * Long-lived GET that replays any event newer than the client's
 * Last-Event-ID, polling the `events` table. Works on any multi-process
 * PHP server (Apache mod_php, php-fpm). `php -S` is single-threaded and
 * will serialize requests, so prefer Apache for SSE.
 */
function sse_stream(): void
{
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

    // Flush every buffered layer so events reach the client immediately.
    while (ob_get_level() > 0) {
        ob_end_flush();
    }
    ob_implicit_flush(true);

    $lastId = 0;
    if (isset($_SERVER['HTTP_LAST_EVENT_ID'])) {
        $lastId = max(0, (int) $_SERVER['HTTP_LAST_EVENT_ID']);
    }

    $stmt = db()->prepare(
        'SELECT id, payload FROM events WHERE id > ? ORDER BY id LIMIT 50'
    );

    $heartbeat = 0;
    while (true) {
        if (connection_aborted()) {
            exit;
        }

        $stmt->execute([$lastId]);
        while ($row = $stmt->fetch()) {
            $lastId = (int) $row['id'];
            echo 'id: ', $lastId, "\n";
            echo 'data: ', $row['payload'], "\n\n";
        }
        flush();

        // Keep the connection alive when idle.
        if (time() - $heartbeat >= 15) {
            $heartbeat = time();
            echo ': ping\n\n';
            flush();
        }

        usleep(250_000); // 4 polls / second is plenty for a board.
    }
}
