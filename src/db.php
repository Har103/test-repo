<?php
declare(strict_types=1);

/**
 * Database layer (schema v2).
 * Plain PDO against MariaDB. No ORM, no libraries.
 * Idempotent: creates the database, tables and migrations on first run,
 * then seeds a demo user + board.
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
    $dsn = sprintf('mysql:host=%s;port=%d;charset=%s', $c['host'], $c['port'], $c['charset']);
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

const SCHEMA_VERSION = 3;

function db_migrate(PDO $pdo): void
{
    $c = config()['db'];
    $pdo->exec("CREATE DATABASE IF NOT EXISTS `" . $c['name'] . "`
                CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
    $pdo = db_connect($c, true);

    $pdo->exec("CREATE TABLE IF NOT EXISTS meta (
        key_name  VARCHAR(40) PRIMARY KEY,
        value     VARCHAR(40) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $version = (int) ($pdo->query("SELECT value FROM meta WHERE key_name = 'schema_version'")
        ->fetchColumn() ?: 0);

    if ($version > 0 && $version < SCHEMA_VERSION) {
        // v1 had a single global board; early v2 drafts had incomplete
        // column sets. The old data has no proper board/user context, so
        // drop it and reseed fresh.
        foreach (['events', 'attachments', 'comments', 'checklist_items', 'card_labels',
                  'cards', 'board_columns', 'boards', 'users'] as $t) {
            $pdo->exec("DROP TABLE IF EXISTS `$t`");
        }
    }

    db_create_tables($pdo);

    $stmt = $pdo->prepare(
        "INSERT INTO meta (key_name, value) VALUES ('schema_version', ?)
         ON DUPLICATE KEY UPDATE value = VALUES(value)"
    );
    $stmt->execute([(string) SCHEMA_VERSION]);
}

function db_create_tables(PDO $pdo): void
{
    $pdo->exec("CREATE TABLE IF NOT EXISTS users (
        id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        username      VARCHAR(60)  NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_users_username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    $pdo->exec("CREATE TABLE IF NOT EXISTS boards (
        id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id    INT UNSIGNED NOT NULL,
        title      VARCHAR(120) NOT NULL,
        theme      VARCHAR(7)   NOT NULL DEFAULT '#0b6e4f',
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_boards_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    $pdo->exec("CREATE TABLE IF NOT EXISTS board_columns (
        id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        board_id   INT UNSIGNED NOT NULL,
        title      VARCHAR(120) NOT NULL,
        position   INT          NOT NULL DEFAULT 0,
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_columns_board FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    $pdo->exec("CREATE TABLE IF NOT EXISTS cards (
        id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        column_id       INT UNSIGNED NOT NULL,
        title           VARCHAR(200) NOT NULL,
        description_html TEXT        NULL,
        due_date        DATE         NULL,
        position        INT          NOT NULL DEFAULT 0,
        created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                      ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_cards_column FOREIGN KEY (column_id)
            REFERENCES board_columns(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    $pdo->exec("CREATE TABLE IF NOT EXISTS card_labels (
        id      INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        card_id INT UNSIGNED NOT NULL,
        text    VARCHAR(60)  NOT NULL DEFAULT '',
        color   VARCHAR(7)   NOT NULL DEFAULT '#3b82f6',
        CONSTRAINT fk_labels_card FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    $pdo->exec("CREATE TABLE IF NOT EXISTS checklist_items (
        id       INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        card_id  INT UNSIGNED NOT NULL,
        text     VARCHAR(300) NOT NULL,
        checked  TINYINT(1)   NOT NULL DEFAULT 0,
        position INT          NOT NULL DEFAULT 0,
        CONSTRAINT fk_checklist_card FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    $pdo->exec("CREATE TABLE IF NOT EXISTS comments (
        id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        card_id    INT UNSIGNED NOT NULL,
        user_id    INT UNSIGNED NOT NULL,
        body_html  TEXT        NOT NULL,
        created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_comments_card FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE,
        CONSTRAINT fk_comments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    $pdo->exec("CREATE TABLE IF NOT EXISTS attachments (
        id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        card_id    INT UNSIGNED NOT NULL,
        comment_id INT UNSIGNED NULL,
        user_id    INT UNSIGNED NOT NULL,
        name       VARCHAR(255) NOT NULL,
        stored     VARCHAR(80)  NOT NULL,
        mime       VARCHAR(100) NOT NULL,
        size       INT UNSIGNED NOT NULL DEFAULT 0,
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_attachments_card FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE,
        CONSTRAINT fk_attachments_comment FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
        CONSTRAINT fk_attachments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    // In-place migration for databases created before comment attachments
    // existed (schema version 4 added attachments.comment_id).
    $cols = array_column($pdo->query("SHOW COLUMNS FROM attachments")->fetchAll(), 'Field');
    if (!in_array('comment_id', $cols, true)) {
        $pdo->exec("ALTER TABLE attachments
            ADD COLUMN comment_id INT UNSIGNED NULL AFTER card_id,
            ADD CONSTRAINT fk_attachments_comment FOREIGN KEY (comment_id)
                REFERENCES comments(id) ON DELETE CASCADE");
    }

    $pdo->exec("CREATE TABLE IF NOT EXISTS login_attempts (
        bucket       VARCHAR(96) PRIMARY KEY,
        attempts     INT          NOT NULL DEFAULT 0,
        locked_until DATETIME     NULL,
        updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    $pdo->exec("CREATE TABLE IF NOT EXISTS events (
        id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        board_id   INT UNSIGNED NOT NULL DEFAULT 0,
        actor_id   INT UNSIGNED NULL,
        type       VARCHAR(40)  NOT NULL,
        payload    TEXT         NOT NULL,
        client_tx  VARCHAR(40)  NOT NULL DEFAULT '',
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_events_board (board_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
}

/**
 * Shared PDO handle, initialising schema on first call.
 */
function db(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $c = config()['db'];
        $pdo = db_connect($c, false);
        db_migrate($pdo);
        $pdo = db_connect($c, true);
        seed_demo_user();
    }
    return $pdo;
}

/**
 * First run: a demo user so the app is immediately usable.
 */
function seed_demo_user(): void
{
    $exists = db()->query("SELECT COUNT(*) FROM users")->fetchColumn();
    if ((int) $exists > 0) {
        return;
    }
    require_once __DIR__ . '/auth.php';
    $pdo = db();
    $stmt = $pdo->prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
    $stmt->execute(['demo', password_hash('demo123', PASSWORD_DEFAULT)]);
    $userId = (int) $pdo->lastInsertId();

    $stmt = $pdo->prepare('INSERT INTO boards (user_id, title, theme) VALUES (?, ?, ?)');
    $stmt->execute([$userId, 'Welcome board', '#0b6e4f']);
    $boardId = (int) $pdo->lastInsertId();

    $cols = [
        ['To do', ['Plan the clone', 'Sketch the schema', 'Pick the stack (PHP · MariaDB · Rust · vanilla JS)']],
        ['Doing', ['Build the realtime core']],
        ['Done', ['Zero frameworks, zero libraries']],
    ];
    foreach ($cols as $i => [$title, $cards]) {
        $pdo->prepare('INSERT INTO board_columns (board_id, title, position) VALUES (?, ?, ?)')
            ->execute([$boardId, $title, $i]);
        $colId = (int) $pdo->lastInsertId();
        foreach ($cards as $j => $cardTitle) {
            $pdo->prepare('INSERT INTO cards (column_id, title, position, description_html) VALUES (?, ?, ?, ?)')
                ->execute([$colId, $cardTitle, $j, '<p>Write it once, sync it everywhere.</p>']);
        }
    }
}
