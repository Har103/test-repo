<?php
declare(strict_types=1);

/**
 * Small HTTP / JSON helpers. No framework, no libraries.
 */

function send_json($data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function send_error(string $message, int $status = 400): void
{
    send_json(['ok' => false, 'error' => $message], $status);
}

function body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function require_str(array $data, string $key, int $max = 200): string
{
    $v = $data[$key] ?? '';
    $v = is_string($v) ? trim($v) : '';
    if ($v === '') {
        send_error("Missing or empty '$key'");
    }
    if (mb_strlen($v) > $max) {
        send_error("'$key' is too long (max $max chars)");
    }
    return $v;
}

function opt_str(array $data, string $key, ?string $default = null, int $max = 4000): ?string
{
    if (!array_key_exists($key, $data) || $data[$key] === null) {
        return $default;
    }
    $v = is_string($data[$key]) ? trim($data[$key]) : (string) $data[$key];
    if (mb_strlen($v) > $max) {
        send_error("'$key' is too long (max $max chars)");
    }
    return $v;
}

/**
 * URL prefix of the entry script, relative to the document root.
 * - Apache in a sub-folder  -> "/dockerup/public"
 * - Apache at web root      -> ""
 * - `php -S` built-in server-> "" (the router is invisible in the URL)
 */
function app_base(): string
{
    $docroot = rtrim(str_replace('\\', '/', $_SERVER['DOCUMENT_ROOT'] ?? ''), '/');
    $file = str_replace('\\', '/', $_SERVER['SCRIPT_FILENAME'] ?? '');
    if ($docroot !== '' && strpos($file, $docroot) === 0) {
        $rel = dirname(substr($file, strlen($docroot)));
        return $rel === '/' ? '' : $rel;
    }
    return '';
}

/**
 * Split a request path into segments, stripping the query string and the
 * application's base directory if we are served from a sub-folder.
 */
function path_segments(): array
{
    $uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
    $base = app_base();
    if ($base !== '' && strpos($uri, $base) === 0) {
        $uri = substr($uri, strlen($base));
    }
    $uri = '/' . ltrim($uri, '/');
    $segments = explode('/', trim($uri, '/'));
    return array_values(array_filter($segments, static fn($s) => $s !== ''));
}

function random_id(): string
{
    return bin2hex(random_bytes(8));
}
