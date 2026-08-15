<?php
declare(strict_types=1);

/**
 * Realtime event fan-out.
 *
 * Every mutation is:
 *   1. written to the `events` table  -> feeds SSE readers (via PHP)
 *   2. POSTed to the Rust WebSocket server -> feeds WS readers (via Rust)
 *
 * Both transports therefore receive the exact same JSON payload.
 */

function ws_url(string $path = '/broadcast'): string
{
    $c = config()['ws'];
    return sprintf('http://%s:%d%s', $c['host'], $c['port'], $path);
}

/**
 * Notify the Rust broadcast server. Fire-and-forget: never blocks or throws
 * when the Rust process is not running (the app degrades to SSE-only).
 */
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
function record_event(string $type, array $data, ?string $clientTx = null): void
{
    $payload = json_encode([
        'type'      => $type,
        'data'      => $data,
        'clientTx'  => $clientTx ?? '',
        'ts'        => microtime(true),
    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

    $stmt = db()->prepare('INSERT INTO events (type, payload, client_tx) VALUES (?, ?, ?)');
    $stmt->execute([$type, $payload, $clientTx ?? '']);

    ws_broadcast($payload);
}
