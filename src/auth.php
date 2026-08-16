<?php
declare(strict_types=1);

/**
 * Authentication: register / login / logout / sessions.
 * Core PHP sessions + password_hash (argon2/bcrypt via PHP core).
 */

function session_start_app(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    session_set_cookie_params([
        'httponly' => true,
        'samesite' => 'Lax',
        'path'     => '/',
    ]);
    session_name('dockup_session');
    session_start();
}

function current_user(): ?array
{
    session_start_app();
    if (empty($_SESSION['user_id'])) {
        return null;
    }
    static $user = null;
    if ($user === null) {
        $stmt = db()->prepare('SELECT id, username, created_at FROM users WHERE id = ?');
        $stmt->execute([(int) $_SESSION['user_id']]);
        $user = $stmt->fetch() ?: null;
    }
    return $user;
}

function require_auth(): array
{
    $user = current_user();
    if ($user === null) {
        send_error('Not authenticated', 401);
    }
    return $user;
}

/**
 * Lightweight CSRF defence for state-changing requests: when the browser
 * sends an Origin / Sec-Fetch-Site header, it must be same-origin.
 * (Native fetch always sends these; a cross-site form does not carry
 * a matching Origin that we trust.)
 */
function guard_mutation(): void
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? null;
    if ($origin === null) {
        $secFetch = $_SERVER['HTTP_SEC_FETCH_SITE'] ?? null;
        if ($secFetch !== null && in_array($secFetch, ['cross-site', 'same-site'], true)) {
            send_error('Cross-site request blocked', 403);
        }
        return; // no signal: allow (CLI, old clients)
    }

    $host = $_SERVER['HTTP_HOST'] ?? '';
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $expected = $scheme . '://' . $host;
    if (!in_array($origin, [$expected, $scheme . '://' . $host . '/'], true)) {
        send_error('Cross-origin request blocked', 403);
    }
}

function auth_register(string $username, string $password): array
{
    $username = trim($username);
    if (!preg_match('/^[a-zA-Z0-9_.-]{3,30}$/', $username)) {
        send_error('Username: 3–30 chars, letters, digits, . _ - only', 422);
    }
    if (strlen($password) < 6) {
        send_error('Password must be at least 6 characters', 422);
    }

    $exists = db()->prepare('SELECT id FROM users WHERE username = ?');
    $exists->execute([$username]);
    if ($exists->fetch()) {
        send_error('Username already taken', 409);
    }

    $stmt = db()->prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
    $stmt->execute([$username, password_hash($password, PASSWORD_DEFAULT)]);
    $user = ['id' => (int) db()->lastInsertId(), 'username' => $username];

    auth_login_session($user);
    return $user;
}

/**
 * Brute-force throttle. Failed logins are counted per username AND per IP
 * in the `login_attempts` table; MAX_ATTEMPTS failures in the window locks
 * the bucket for LOCK_MINUTES. A locked bucket answers 429 before the
 * password is even verified, and every failure also costs a small sleep so
 * an attacker cannot hammer through quickly.
 */
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_MAX_ATTEMPTS_IP = 20;
const LOGIN_LOCK_MINUTES = 15;

function login_bucket(string $key): array
{
    $s = db()->prepare('SELECT attempts, locked_until FROM login_attempts WHERE bucket = ?');
    $s->execute([$key]);
    return $s->fetch(PDO::FETCH_ASSOC) ?: ['attempts' => 0, 'locked_until' => null];
}

function login_check_lockout(string $username): void
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    foreach ([login_bucket('u:' . mb_substr($username, 0, 40)), login_bucket('ip:' . mb_substr($ip, 0, 45))] as $row) {
        if ($row['locked_until'] !== null && strtotime($row['locked_until']) > time()) {
            send_error('Too many attempts. Try again later.', 429);
        }
    }
}

function login_record_failure(string $username): void
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    $buckets = [
        ['u:' . mb_substr($username, 0, 40), LOGIN_MAX_ATTEMPTS],
        ['ip:' . mb_substr($ip, 0, 45), LOGIN_MAX_ATTEMPTS_IP],
    ];
    foreach ($buckets as [$key, $max]) {
        db()->prepare('INSERT INTO login_attempts (bucket, attempts) VALUES (?, 1)
            ON DUPLICATE KEY UPDATE attempts = attempts + 1')->execute([$key]);
        db()->prepare('UPDATE login_attempts SET locked_until = DATE_ADD(NOW(), INTERVAL ' . LOGIN_LOCK_MINUTES . ' MINUTE)
            WHERE bucket = ? AND attempts >= ' . (int) $max)->execute([$key]);
    }
    usleep(250000); // every failure also costs a quarter second
}

function login_clear_failures(string $username): void
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    foreach (['u:' . mb_substr($username, 0, 40), 'ip:' . mb_substr($ip, 0, 45)] as $key) {
        db()->prepare('DELETE FROM login_attempts WHERE bucket = ?')->execute([$key]);
    }
}

function auth_login(string $username, string $password): ?array
{
    login_check_lockout($username);

    $stmt = db()->prepare('SELECT * FROM users WHERE username = ?');
    $stmt->execute([trim($username)]);
    $row = $stmt->fetch();
    if ($row === false || !password_verify($password, $row['password_hash'])) {
        login_record_failure($username);
        return null;
    }

    login_clear_failures($username);
    $user = ['id' => (int) $row['id'], 'username' => $row['username'], 'created_at' => $row['created_at']];
    auth_login_session($user);
    return $user;
}

function auth_login_session(array $user): void
{
    session_start_app();
    // Kill any legacy dockup_session cookie set at the app path (older
    // builds defaulted the cookie path to the request path). Per RFC 6265
    // the longer path wins, so a stale /dockerup/public cookie would shadow
    // the regenerated '/'-path cookie and log the user out on the very
    // next request.
    setcookie('dockup_session', '', time() - 86400, app_base());
    setcookie('dockup_session', '', time() - 86400, app_base() . '/');
    setcookie('dockup_session', '', time() - 86400, '/');
    session_regenerate_id(true);
    $_SESSION['user_id'] = $user['id'];
    $_SESSION['username'] = $user['username'];
}

function auth_logout(): void
{
    session_start_app();
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
    }
    session_destroy();
}
