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

function ws_broadcast(string $payload): void
{
    $ctx = stream_context_create([
        'http' => [
            'method'        => 'POST',
            'header'        => "Content-Type: application/json\r\nConnection: close\r\n",
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
