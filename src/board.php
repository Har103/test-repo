<?php
declare(strict_types=1);

/**
 * Domain logic: boards, columns, cards, labels, checklists, comments,
 * attachments. Every entity is scoped to a user via board ownership.
 */

require_once __DIR__ . '/sanitize.php';

/* ------------------------------ boards ---------------------------- */

function board_owned(int $boardId, int $userId): ?array
{
    $stmt = db()->prepare('SELECT * FROM boards WHERE id = ? AND user_id = ?');
    $stmt->execute([$boardId, $userId]);
    return $stmt->fetch() ?: null;
}

function user_boards(int $userId): array
{
    $stmt = db()->prepare('SELECT b.*, (SELECT COUNT(*) FROM cards c
        JOIN board_columns bc ON bc.id = c.column_id WHERE bc.board_id = b.id) AS card_count
        FROM boards b WHERE b.user_id = ? ORDER BY b.created_at DESC, b.id DESC');
    $stmt->execute([$userId]);
    return $stmt->fetchAll();
}

function create_board(int $userId, string $title, string $theme): array
{
    $stmt = db()->prepare('INSERT INTO boards (user_id, title, theme) VALUES (?, ?, ?)');
    $stmt->execute([$userId, $title, $theme]);
    return board_owned((int) db()->lastInsertId(), $userId);
}

function update_board(int $boardId, int $userId, ?string $title, ?string $theme): ?array
{
    $board = board_owned($boardId, $userId);
    if ($board === null) {
        return null;
    }
    $stmt = db()->prepare('UPDATE boards SET title = ?, theme = ? WHERE id = ?');
    $stmt->execute([$title ?? $board['title'], $theme ?? $board['theme'], $boardId]);
    return board_owned($boardId, $userId);
}

function delete_board(int $boardId, int $userId): bool
{
    if (board_owned($boardId, $userId) === null) {
        return false;
    }
    db()->prepare('DELETE FROM boards WHERE id = ?')->execute([$boardId]);
    return true;
}

/* ------------------------- board snapshot ------------------------- */

function column_owned(int $columnId, int $userId): ?array
{
    $stmt = db()->prepare('SELECT bc.* FROM board_columns bc
        JOIN boards b ON b.id = bc.board_id WHERE bc.id = ? AND b.user_id = ?');
    $stmt->execute([$columnId, $userId]);
    return $stmt->fetch() ?: null;
}

function card_owned(int $cardId, int $userId): ?array
{
    $stmt = db()->prepare('SELECT c.* FROM cards c
        JOIN board_columns bc ON bc.id = c.column_id
        JOIN boards b ON b.id = bc.board_id
        WHERE c.id = ? AND b.user_id = ?');
    $stmt->execute([$cardId, $userId]);
    return $stmt->fetch() ?: null;
}

function board_snapshot(int $boardId, int $userId): ?array
{
    $board = board_owned($boardId, $userId);
    if ($board === null) {
        return null;
    }

    $stmt = db()->prepare('SELECT * FROM board_columns WHERE board_id = ? ORDER BY position, id');
    $stmt->execute([$boardId]);
    $columns = $stmt->fetchAll();

    foreach ($columns as &$col) {
        $s = db()->prepare('SELECT * FROM cards WHERE column_id = ? ORDER BY position, id');
        $s->execute([$col['id']]);
        $cards = $s->fetchAll();
        foreach ($cards as &$card) {
            $card['badges'] = card_badges((int) $card['id']);
        }
        unset($card);
        $col['cards'] = $cards;
    }
    unset($col);

    return ['board' => $board, 'columns' => $columns];
}

function card_badges(int $cardId): array
{
    $count = static function (string $table) use ($cardId): int {
        $s = db()->prepare("SELECT COUNT(*) FROM $table WHERE card_id = ?");
        $s->execute([$cardId]);
        return (int) $s->fetchColumn();
    };

    $s = db()->prepare('SELECT COUNT(*) AS total, COALESCE(SUM(checked), 0) AS done FROM checklist_items WHERE card_id = ?');
    $s->execute([$cardId]);
    $cl = $s->fetch();

    return [
        'labels'          => $count('card_labels'),
        'checklist'       => (int) $cl['total'],
        'checklist_done'  => (int) $cl['done'],
        'comments'        => $count('comments'),
        'attachments'     => $count('attachments'),
    ];
}

/* ----------------------------- columns ---------------------------- */

function create_column(int $boardId, string $title): array
{
    $pos = next_position('board_columns', 'board_id = ?', [$boardId]);
    $stmt = db()->prepare('INSERT INTO board_columns (board_id, title, position) VALUES (?, ?, ?)');
    $stmt->execute([$boardId, $title, $pos]);
    return column_owned((int) db()->lastInsertId(), board_owner_id($boardId));
}

function board_owner_id(int $boardId): int
{
    $s = db()->prepare('SELECT user_id FROM boards WHERE id = ?');
    $s->execute([$boardId]);
    return (int) $s->fetchColumn();
}

function update_column(int $columnId, string $title): ?array
{
    $col = db()->prepare('SELECT bc.*, b.user_id FROM board_columns bc
        JOIN boards b ON b.id = bc.board_id WHERE bc.id = ?');
    $col->execute([$columnId]);
    $row = $col->fetch();
    if ($row === null) {
        return null;
    }
    db()->prepare('UPDATE board_columns SET title = ? WHERE id = ?')->execute([$title, $columnId]);
    return column_owned($columnId, (int) $row['user_id']);
}

function delete_column(int $columnId): bool
{
    $col = db()->prepare('SELECT bc.*, b.user_id FROM board_columns bc
        JOIN boards b ON b.id = bc.board_id WHERE bc.id = ?');
    $col->execute([$columnId]);
    $row = $col->fetch();
    if ($row === null) {
        return false;
    }
    db()->prepare('DELETE FROM board_columns WHERE id = ?')->execute([$columnId]);
    return true;
}

function move_column(int $columnId, int $position): ?array
{
    $col = db()->prepare('SELECT bc.*, b.user_id FROM board_columns bc
        JOIN boards b ON b.id = bc.board_id WHERE bc.id = ?');
    $col->execute([$columnId]);
    $row = $col->fetch();
    if ($row === null) {
        return null;
    }
    $boardId = (int) $row['board_id'];

    $pdo = db();
    $pdo->beginTransaction();
    try {
        $s = $pdo->prepare('SELECT id FROM board_columns WHERE board_id = ? ORDER BY position, id');
        $s->execute([$boardId]);
        $ids = array_values(array_filter($s->fetchAll(PDO::FETCH_COLUMN), static fn($x) => (int) $x !== $columnId));
        array_splice($ids, max(0, min($position, count($ids))), 0, [$columnId]);
        foreach ($ids as $i => $cid) {
            $pdo->prepare('UPDATE board_columns SET position = ? WHERE id = ?')->execute([$i, $cid]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    return column_owned($columnId, (int) $row['user_id']);
}

/* ------------------------------ cards ----------------------------- */

function next_position(string $table, string $where, array $params): int
{
    $stmt = db()->prepare("SELECT COALESCE(MAX(position), -1) + 1 FROM $table WHERE $where");
    $stmt->execute($params);
    return (int) $stmt->fetchColumn();
}

function create_card(int $columnId, string $title, ?string $descriptionHtml, ?string $dueDate): ?array
{
    $col = column_owned($columnId, current_user_id());
    if ($col === null) {
        return null;
    }
    $pos = next_position('cards', 'column_id = ?', [$columnId]);
    $stmt = db()->prepare(
        'INSERT INTO cards (column_id, title, description_html, due_date, position) VALUES (?, ?, ?, ?, ?)'
    );
    $stmt->execute([$columnId, $title, sanitize_html($descriptionHtml), $dueDate ?: null, $pos]);
    return fetch_card((int) db()->lastInsertId());
}

function current_user_id(): int
{
    return (int) ($_SESSION['user_id'] ?? 0);
}

function fetch_card(int $cardId): ?array
{
    $s = db()->prepare('SELECT * FROM cards WHERE id = ?');
    $s->execute([$cardId]);
    $card = $s->fetch() ?: null;
    if ($card) {
        $card['badges'] = card_badges($cardId);
    }
    return $card;
}

function update_card(int $cardId, ?string $title, ?string $descriptionHtml, ?string $dueDate): ?array
{
    $card = fetch_card($cardId);
    if ($card === null) {
        return null;
    }
    $stmt = db()->prepare('UPDATE cards SET title = ?, description_html = ?, due_date = ? WHERE id = ?');
    $stmt->execute([
        $title ?? $card['title'],
        $descriptionHtml !== null ? sanitize_html($descriptionHtml) : $card['description_html'],
        $dueDate !== null && $dueDate !== '' ? $dueDate : null,
        $cardId,
    ]);
    return fetch_card($cardId);
}

function delete_card(int $cardId): bool
{
    if (fetch_card($cardId) === null) {
        return false;
    }
    delete_card_attachments($cardId);
    db()->prepare('DELETE FROM cards WHERE id = ?')->execute([$cardId]);
    return true;
}

function move_card(int $cardId, int $columnId, int $position): ?array
{
    $card = fetch_card($cardId);
    $col = column_owned($columnId, current_user_id());
    if ($card === null || $col === null) {
        return null;
    }

    $pdo = db();
    $pdo->beginTransaction();
    try {
        $from = (int) $card['column_id'];
        if ($from === $columnId) {
            $s = $pdo->prepare('SELECT id FROM cards WHERE column_id = ? ORDER BY position, id');
            $s->execute([$columnId]);
            $ids = array_values(array_filter($s->fetchAll(PDO::FETCH_COLUMN), static fn($x) => (int) $x !== $cardId));
            array_splice($ids, max(0, min($position, count($ids))), 0, [$cardId]);
            foreach ($ids as $i => $cid) {
                $pdo->prepare('UPDATE cards SET position = ? WHERE id = ?')->execute([$i, $cid]);
            }
        } else {
            $pdo->prepare('UPDATE cards SET column_id = ?, position = ? WHERE id = ?')
                ->execute([$columnId, $position, $cardId]);
            foreach ([$from, $columnId] as $cid) {
                $s = $pdo->prepare('SELECT id FROM cards WHERE column_id = ? ORDER BY position, id');
                $s->execute([$cid]);
                foreach ($s->fetchAll(PDO::FETCH_COLUMN) as $i => $id) {
                    $pdo->prepare('UPDATE cards SET position = ? WHERE id = ?')->execute([$i, $id]);
                }
            }
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    return fetch_card($cardId);
}

/* ------------------------- card detail ---------------------------- */

function card_detail(int $cardId): ?array
{
    $card = fetch_card($cardId);
    if ($card === null) {
        return null;
    }
    $card['labels'] = card_labels($cardId);
    $card['checklist'] = card_checklist($cardId);
    $card['comments'] = card_comments($cardId);
    $card['attachments'] = card_attachments($cardId);
    return $card;
}

function card_labels(int $cardId): array
{
    $s = db()->prepare('SELECT * FROM card_labels WHERE card_id = ? ORDER BY id');
    $s->execute([$cardId]);
    return $s->fetchAll();
}

function add_label(int $cardId, string $text, string $color): ?array
{
    if (fetch_card($cardId) === null) {
        return null;
    }
    $stmt = db()->prepare('INSERT INTO card_labels (card_id, text, color) VALUES (?, ?, ?)');
    $stmt->execute([$cardId, mb_substr(trim($text), 0, 60), mb_substr($color, 0, 7)]);
    $s = db()->prepare('SELECT * FROM card_labels WHERE id = ?');
    $s->execute([db()->lastInsertId()]);
    return $s->fetch() ?: null;
}

function delete_label(int $labelId): bool
{
    db()->prepare('DELETE FROM card_labels WHERE id = ?')->execute([$labelId]);
    return true;
}

function card_checklist(int $cardId): array
{
    $s = db()->prepare('SELECT * FROM checklist_items WHERE card_id = ? ORDER BY position, id');
    $s->execute([$cardId]);
    return $s->fetchAll();
}

function add_checklist_item(int $cardId, string $text): ?array
{
    if (fetch_card($cardId) === null) {
        return null;
    }
    $pos = next_position('checklist_items', 'card_id = ?', [$cardId]);
    $stmt = db()->prepare('INSERT INTO checklist_items (card_id, text, position) VALUES (?, ?, ?)');
    $stmt->execute([$cardId, mb_substr(trim($text), 0, 300), $pos]);
    $s = db()->prepare('SELECT * FROM checklist_items WHERE id = ?');
    $s->execute([db()->lastInsertId()]);
    return $s->fetch() ?: null;
}

function update_checklist_item(int $itemId, ?string $text, ?bool $checked): ?array
{
    $s = db()->prepare('SELECT * FROM checklist_items WHERE id = ?');
    $s->execute([$itemId]);
    $item = $s->fetch() ?: null;
    if ($item === null) {
        return null;
    }
    $stmt = db()->prepare('UPDATE checklist_items SET text = ?, checked = ? WHERE id = ?');
    $stmt->execute([$text ?? $item['text'], $checked === null ? (int) $item['checked'] : (int) $checked, $itemId]);
    $s = db()->prepare('SELECT * FROM checklist_items WHERE id = ?');
    $s->execute([$itemId]);
    return $s->fetch() ?: null;
}

function delete_checklist_item(int $itemId): bool
{
    db()->prepare('DELETE FROM checklist_items WHERE id = ?')->execute([$itemId]);
    return true;
}

function card_comments(int $cardId): array
{
    $s = db()->prepare('SELECT cm.*, u.username FROM comments cm
        JOIN users u ON u.id = cm.user_id
        WHERE cm.card_id = ? ORDER BY cm.created_at, cm.id');
    $s->execute([$cardId]);
    return $s->fetchAll();
}

function add_comment(int $cardId, int $userId, string $bodyHtml): ?array
{
    if (fetch_card($cardId) === null) {
        return null;
    }
    $clean = sanitize_html($bodyHtml);
    if (html_to_plain($clean, 5000) === '') {
        return null;
    }
    $stmt = db()->prepare('INSERT INTO comments (card_id, user_id, body_html) VALUES (?, ?, ?)');
    $stmt->execute([$cardId, $userId, $clean]);
    $s = db()->prepare('SELECT cm.*, u.username FROM comments cm JOIN users u ON u.id = cm.user_id WHERE cm.id = ?');
    $s->execute([db()->lastInsertId()]);
    return $s->fetch() ?: null;
}

function delete_comment(int $commentId, int $userId): bool
{
    $s = db()->prepare('SELECT * FROM comments WHERE id = ? AND user_id = ?');
    $s->execute([$commentId, $userId]);
    if ($s->fetch() === false) {
        return false;
    }
    db()->prepare('DELETE FROM comments WHERE id = ?')->execute([$commentId]);
    return true;
}

/* --------------------------- attachments -------------------------- */

const UPLOAD_DIR = 'uploads';
const MAX_UPLOAD = 5 * 1024 * 1024; // 5 MB

function upload_dir(): string
{
    return dirname(__DIR__) . '/public/' . UPLOAD_DIR;
}

function ensure_upload_dir(): void
{
    $dir = upload_dir();
    if (!is_dir($dir)) {
        mkdir($dir, 0777, true);
    }
}

function store_attachment(int $cardId, int $userId, array $file): ?array
{
    if (fetch_card($cardId) === null) {
        return null;
    }
    if ($file['error'] !== UPLOAD_ERR_OK) {
        send_error('Upload failed', 422);
    }
    if ($file['size'] > MAX_UPLOAD || $file['size'] <= 0) {
        send_error('File too large (max 5 MB)', 422);
    }
    if (!is_uploaded_file($file['tmp_name'])) {
        send_error('Invalid upload', 422);
    }

    $finfo = function_exists('finfo_open') ? finfo_open(FILEINFO_MIME_TYPE) : false;
    $mime = $finfo ? (string) finfo_file($finfo, $file['tmp_name']) : 'application/octet-stream';
    if ($finfo) {
        finfo_close($finfo);
    }
    if (!preg_match('#^(image/(jpeg|png|gif|webp)|application/pdf|text/plain|application/json)$#', $mime)) {
        send_error('File type not allowed (images, PDF, text, JSON)', 422);
    }

    $ext = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/gif' => 'gif',
            'image/webp' => 'webp', 'application/pdf' => 'pdf', 'text/plain' => 'txt',
            'application/json' => 'json'][$mime] ?? 'bin';

    ensure_upload_dir();
    $stored = bin2hex(random_bytes(16)) . '.' . $ext;
    if (!move_uploaded_file($file['tmp_name'], upload_dir() . '/' . $stored)) {
        send_error('Could not store file', 500);
    }

    $stmt = db()->prepare('INSERT INTO attachments (card_id, user_id, name, stored, mime, size) VALUES (?, ?, ?, ?, ?, ?)');
    $stmt->execute([
        $cardId, $userId,
        mb_substr(basename($file['name']), 0, 200),
        $stored, $mime, (int) $file['size'],
    ]);

    $s = db()->prepare('SELECT * FROM attachments WHERE id = ?');
    $s->execute([db()->lastInsertId()]);
    return $s->fetch() ?: null;
}

function delete_card_attachments(int $cardId): void
{
    $s = db()->prepare('SELECT stored FROM attachments WHERE card_id = ?');
    $s->execute([$cardId]);
    foreach ($s->fetchAll(PDO::FETCH_COLUMN) as $stored) {
        @unlink(upload_dir() . '/' . $stored);
    }
    db()->prepare('DELETE FROM attachments WHERE card_id = ?')->execute([$cardId]);
}

function delete_attachment(int $attachmentId, int $userId): bool
{
    $s = db()->prepare('SELECT * FROM attachments WHERE id = ? AND user_id = ?');
    $s->execute([$attachmentId, $userId]);
    $row = $s->fetch();
    if ($row === false) {
        return false;
    }
    @unlink(upload_dir() . '/' . $row['stored']);
    db()->prepare('DELETE FROM attachments WHERE id = ?')->execute([$attachmentId]);
    return true;
}

function card_attachments(int $cardId): array
{
    $s = db()->prepare('SELECT * FROM attachments WHERE card_id = ? ORDER BY created_at DESC, id DESC');
    $s->execute([$cardId]);
    return $s->fetchAll();
}
