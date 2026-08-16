<?php
declare(strict_types=1);

/**
 * Realtime event fan-out.
 *
 * Every mutation:
 *   1. is written to the `events` table  -> feeds SSE readers (PHP)
 *   2. is POSTed to the Rust WebSocket server -> feeds WS readers (Rust)
 *
 * Both transports deliver the exact same JSON payload, which includes the
 * board id and the acting user so clients can scope and display it.
 */

function ws_url(string $path = '/broadcast'): string
{
    $c = config()['ws'];
    return sprintf('http://%s:%d%s', $c['host'], $c['port'], $path);
}

function ws_alive(): bool
{
    $ctx = stream_context_create([
        'http' => ['method' => 'GET', 'timeout' => 0.4, 'ignore_errors' => true],
    ]);
    $body = @file_get_contents(ws_url('/status'), false, $ctx);
    if ($body === false) {
        return false;
    }
    $j = json_decode($body, true);
    return is_array($j) && isset($j['clients']);
}

/**
 * Boot the Rust broadcast server if it is not running (e.g. after a
 * reboot). Called on /api/health and before every broadcast, so the
 * WebSocket transport heals itself. Disable with WS_AUTO_START=0.
 */
function ws_ensure_running(): void
{
    static $attempted = false;
    if ($attempted) {
        return;
    }
    $attempted = true;

    $ws = config()['ws'];
    if (!$ws['auto_start'] || ws_alive()) {
        return;
    }

    $exe = dirname(__DIR__) . '/server/target/release/board_ws.exe';
    if (!is_file($exe)) {
        error_log('ws_ensure_running: board_ws.exe not found at ' . $exe);
        return;
    }

    $origin = $ws['origin'];
    $cmd = [$exe, (string) $ws['port'], '--token', $ws['token']];
    if ($origin !== '') {
        $cmd[] = '--origin';
        $cmd[] = $origin;
    }

    // Array command form = no cmd.exe involved, so no shell quoting and no
    // inherited stdout/stderr pipes — the request must not block on the
    // detached server. Logs go to per-port files (gitignored). The process
    // handle is deliberately never closed: closing would wait for
    // termination.
    $root = dirname(__DIR__);
    @proc_open($cmd, [
        0 => ['file', 'NUL', 'r'],
        1 => ['file', $root . '\ws-server-' . (int) $ws['port'] . '.log', 'a'],
        2 => ['file', $root . '\ws-server-' . (int) $ws['port'] . '.err.log', 'a'],
    ], $pipes);

    // Give the binary a moment to bind before the caller proceeds.
    for ($i = 0; $i < 20; $i++) {
        if (ws_alive()) {
            return;
        }
        usleep(100000);
    }
    error_log('ws_ensure_running: spawned but /status never came up');
}

function ws_broadcast(string $payload): void
{
    ws_ensure_running();
    $ctx = stream_context_create([
        'http' => [
            'method'        => 'POST',
            'header'        => "Content-Type: application/json\r\n"
                . 'Authorization: Bearer ' . config()['ws']['token'] . "\r\n"
                . "Connection: close\r\n",
            'content'       => $payload,
            'timeout'       => 1,
            'ignore_errors' => true,
        ],
    ]);
    @file_get_contents(ws_url('/broadcast'), false, $ctx);
}

/**
 * Persist an event and push it to both transports.
 */
function record_event(string $type, int $boardId, array $data, ?string $clientTx = null): void
{
    $user = current_user();
    $payload = json_encode([
        'type'     => $type,
        'boardId'  => $boardId,
        'actor'    => $user['username'] ?? 'system',
        'data'     => $data,
        'clientTx' => $clientTx ?? '',
        'ts'       => microtime(true),
    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

    $stmt = db()->prepare('INSERT INTO events (board_id, actor_id, type, payload, client_tx) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([$boardId, $user['id'] ?? null, $type, $payload, $clientTx ?? '']);

    // Keep the table bounded: nothing older than an hour is ever replayed
    // (fresh SSE connects only see the last 15 seconds), so old rows are
    // pure growth. Delete them opportunistically.
    static $pruned = false;
    if (!$pruned) {
        $pruned = true;
        db()->prepare('DELETE FROM events WHERE created_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)')->execute();
    }

    ws_broadcast($payload);
}

/**
 * Resolve the board id of a column or card (for event scoping).
 */
function board_id_of_column(int $columnId): int
{
    $s = db()->prepare('SELECT board_id FROM board_columns WHERE id = ?');
    $s->execute([$columnId]);
    return (int) $s->fetchColumn();
}

function board_id_of_card(int $cardId): int
{
    $s = db()->prepare('SELECT bc.board_id FROM cards c JOIN board_columns bc ON bc.id = c.column_id WHERE c.id = ?');
    $s->execute([$cardId]);
    return (int) $s->fetchColumn();
}
