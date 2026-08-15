<?php
declare(strict_types=1);

/**
 * Database layer.
 * Plain PDO against MariaDB. No ORM, no libraries.
 * The database and tables are created automatically on first run.
 */

function config(): array
{
    static $cfg = null;
    if ($cfg === null) {
        global $config;
        require_once __DIR__ . '/config.php';
        $cfg = $config;
        date_default_timezone_set($cfg['timezone'] ?? 'UTC');
    }
    return $cfg;
}

function db_dsn(array $c, bool $withDb = true): string
{
    $dsn = sprintf(
        'mysql:host=%s;port=%d;charset=%s',
        $c['host'],
        $c['port'],
        $c['charset']
    );
    if ($withDb) {
        $dsn .= ';dbname=' . $c['name'];
    }
    return $dsn;
}

function db_connect(array $c, bool $withDb = true): PDO
{
    $pdo = new PDO(db_dsn($c, $withDb), $c['user'], $c['pass'], [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ]);
    $pdo->exec("SET NAMES 'utf8mb4'");
    return $pdo;
}

/**
 * Create the database (if missing) and every table we need.
 * Safe to run on every request: cheap, idempotent, self-healing.
 */
function db_init(PDO $pdo): void
{
    $c = config()['db'];

    // Create the schema itself when it does not exist yet.
    $pdo->exec("CREATE DATABASE IF NOT EXISTS `" . $c['name'] . "`
                CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");

    // Reconnect pointing at the database.
    $pdo = db_connect($c, true);

    $pdo->exec("CREATE TABLE IF NOT EXISTS board_columns (
        id        INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        title     VARCHAR(120)    NOT NULL,
        color     VARCHAR(7)      NOT NULL DEFAULT '#3b82f6',
        position  INT             NOT NULL DEFAULT 0,
        created_at TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    $pdo->exec("CREATE TABLE IF NOT EXISTS cards (
        id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        column_id  INT UNSIGNED  NOT NULL,
        title      VARCHAR(200)  NOT NULL,
        note       TEXT          NULL,
        position   INT           NOT NULL DEFAULT 0,
        created_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                  ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_cards_column FOREIGN KEY (column_id)
            REFERENCES board_columns(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    $pdo->exec("CREATE TABLE IF NOT EXISTS events (
        id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        type       VARCHAR(40)  NOT NULL,
        payload    TEXT         NOT NULL,
        client_tx  VARCHAR(40)  NOT NULL DEFAULT '',
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_events_id (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    return;
}

/**
 * Return a shared PDO handle, initialising schema on first call.
 */
function db(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $c = config()['db'];
        $pdo = db_connect($c, false);
        db_init($pdo);
        $pdo = db_connect($c, true);
    }
    return $pdo;
}
