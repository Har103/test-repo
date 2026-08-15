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
    'ws' => [
        'host' => env('WS_HOST', '127.0.0.1'),
        'port' => (int) env('WS_PORT', '9001'),
    ],

    'timezone' => 'UTC',
];

return $config;
