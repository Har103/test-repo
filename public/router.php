<?php
declare(strict_types=1);

/**
 * Router for `php -S 127.0.0.1:8080 public/router.php`
 * (the built-in server serves static assets itself).
 */

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$file = __DIR__ . $path;

if ($path !== '/' && is_file($file) && preg_match('/\.(css|js|png|jpg|svg|ico|woff2?)$/', $path)) {
    return false; // let the built-in server serve it
}

require __DIR__ . '/index.php';
