<?php
declare(strict_types=1);

/**
 * Configuration.
 * Everything can be overridden through environment variables so the app
 * runs anywhere (WAMP, Docker, bare metal) without touching code.
 */

function env(string $key, string $default = ''): string
{
    $v = getenv($key);
    return ($v === false || $v === '') ? $default : $v;
}

$config = [
    'db' => [
        // Defaults match this WAMP install (MariaDB 11.5 on port 3307;
        // a separate MySQL server occupies 3306). Override freely.
        'host' => env('DB_HOST', '127.0.0.1'),
        'port' => (int) env('DB_PORT', '3307'),
        'user' => env('DB_USER', 'root'),
        'pass' => env('DB_PASS', ''),
        'name' => env('DB_NAME', 'dockerup_board'),
        'charset' => 'utf8mb4',
    ],

    // Rust WebSocket broadcast server (pure std, no libraries).
    // The token must match BOARD_WS_TOKEN on the server side; without it
    // /broadcast answers 401 so a random network client cannot inject
    // forged events into every open board.
    'ws' => [
        'host' => env('WS_HOST', '127.0.0.1'),
        'port' => (int) env('WS_PORT', '9001'),
        'token' => env('BOARD_WS_TOKEN', 'dockup-ws-dev-token'),
        // Origin allowlist passed to the Rust server (empty = allow any
        // origin). When PHP auto-starts the server it hands this over as
        // the --origin CLI arg. Defaults to localhost so the common
        // single-machine deployment keeps the upgrade gate; set it to your
        // real origin (or empty) for other setups.
        'origin' => env('BOARD_WS_ALLOWED_ORIGIN', 'http://localhost'),
        // PHP checks /status and spawns server/target/release/board_ws.exe
        // itself if the server is not running (health checks + every
        // broadcast). Set WS_AUTO_START=0 to disable.
        'auto_start' => env('WS_AUTO_START', '1') === '1',
    ],

    'timezone' => 'UTC',
];

return $config;
