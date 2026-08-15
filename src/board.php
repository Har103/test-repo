<?php
declare(strict_types=1);

/**
 * Board domain logic: columns and cards, plus the full-board snapshot
 * the client needs to render everything.
 */

function fetch_column(int $id): ?array
{
    $stmt = db()->prepare('SELECT * FROM board_columns WHERE id = ?');
    $stmt->execute([$id]);
    return $stmt->fetch() ?: null;
}

function fetch_card(int $id): ?array
{
    $stmt = db()->prepare('SELECT * FROM cards WHERE id = ?');
    $stmt->execute([$id]);
    return $stmt->fetch() ?: null;
}

function next_position(string $table, string $where = '', array $params = []): int
{
    $sql = "SELECT COALESCE(MAX(position), -1) + 1 FROM $table";
    if ($where !== '') {
        $sql .= " WHERE $where";
    }
    $stmt = db()->prepare($sql);
    $stmt->execute($params);
    return (int) $stmt->fetchColumn();
}

function create_column(string $title, string $color): array
{
    $pos = next_position('board_columns');
    $stmt = db()->prepare('INSERT INTO board_columns (title, color, position) VALUES (?, ?, ?)');
    $stmt->execute([$title, $color, $pos]);
    $column = fetch_column((int) db()->lastInsertId());

    record_event('column.created', ['column' => $column]);
    return $column;
}

function update_column(int $id, string $title, ?string $color): ?array
{
    $column = fetch_column($id);
    if ($column === null) {
        return null;
    }
    $stmt = db()->prepare('UPDATE board_columns SET title = ?, color = ? WHERE id = ?');
    $stmt->execute([$title, $color ?? $column['color'], $id]);
    $column = fetch_column($id);

    record_event('column.updated', ['column' => $column]);
    return $column;
}

function delete_column(int $id): bool
{
    if (fetch_column($id) === null) {
        return false;
    }
    db()->prepare('DELETE FROM board_columns WHERE id = ?')->execute([$id]);

    record_event('column.deleted', ['id' => $id]);
    return true;
}

function create_card(int $columnId, string $title, ?string $note): ?array
{
    if (fetch_column($columnId) === null) {
        return null;
    }
    $pos = next_position('cards', 'column_id = ?', [$columnId]);
    $stmt = db()->prepare('INSERT INTO cards (column_id, title, note, position) VALUES (?, ?, ?, ?)');
    $stmt->execute([$columnId, $title, $note, $pos]);
    $card = fetch_card((int) db()->lastInsertId());

    record_event('card.created', ['card' => $card]);
    return $card;
}

function update_card(int $id, string $title, ?string $note): ?array
{
    $card = fetch_card($id);
    if ($card === null) {
        return null;
    }
    $stmt = db()->prepare('UPDATE cards SET title = ?, note = ? WHERE id = ?');
    $stmt->execute([$title, $note, $id]);
    $card = fetch_card($id);

    record_event('card.updated', ['card' => $card]);
    return $card;
}

function delete_card(int $id): bool
{
    if (fetch_card($id) === null) {
        return false;
    }
    db()->prepare('DELETE FROM cards WHERE id = ?')->execute([$id]);

    record_event('card.deleted', ['id' => $id]);
    return true;
}

/**
 * Move a card to `columnId` at index `position`.
 * Positions in both the source and target columns are renumbered so the
 * board always stays consistent for every connected client.
 */
function move_card(int $id, int $columnId, int $position): ?array
{
    $card = fetch_card($id);
    if ($card === null || fetch_column($columnId) === null) {
        return null;
    }

    $pdo = db();
    $pdo->beginTransaction();
    try {
        $from = (int) $card['column_id'];

        if ($from === $columnId) {
            // Reorder within the same column.
            $stmt = $pdo->prepare('SELECT id FROM cards WHERE column_id = ? ORDER BY position, id');
            $stmt->execute([$columnId]);
            $ids = $stmt->fetchAll(PDO::FETCH_COLUMN);
            $ids = array_values(array_filter($ids, static fn($x) => (int) $x !== $id));
            array_splice($ids, max(0, min($position, count($ids))), 0, [$id]);
            foreach ($ids as $i => $cid) {
                $pdo->prepare('UPDATE cards SET position = ? WHERE id = ?')->execute([$i, $cid]);
            }
        } else {
            // Leave the source column, landing at `position` in the target.
            $pdo->prepare('UPDATE cards SET column_id = ?, position = ? WHERE id = ?')
                ->execute([$columnId, $position, $id]);

            $stmt = $pdo->prepare('SELECT id FROM cards WHERE column_id = ? ORDER BY position, id');
            $stmt->execute([$from]);
            foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $i => $cid) {
                $pdo->prepare('UPDATE cards SET position = ? WHERE id = ?')->execute([$i, $cid]);
            }

            $stmt = $pdo->prepare('SELECT id FROM cards WHERE column_id = ? ORDER BY position, id');
            $stmt->execute([$columnId]);
            foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $i => $cid) {
                $pdo->prepare('UPDATE cards SET position = ? WHERE id = ?')->execute([$i, $cid]);
            }
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }

    $card = fetch_card($id);
    record_event('card.moved', ['card' => $card]);
    return $card;
}

/**
 * Full board snapshot: columns ordered, each with its ordered cards.
 */
function board_snapshot(): array
{
    $columns = db()->query(
        'SELECT * FROM board_columns ORDER BY position, id'
    )->fetchAll();

    foreach ($columns as &$column) {
        $stmt = db()->prepare(
            'SELECT * FROM cards WHERE column_id = ? ORDER BY position, id'
        );
        $stmt->execute([$column['id']]);
        $column['cards'] = $stmt->fetchAll();
    }
    unset($column);

    return $columns;
}

function seed_demo(): void
{
    $pdo = db();
    $pdo->exec('DELETE FROM cards');
    $pdo->exec('DELETE FROM board_columns');
    $pdo->exec('DELETE FROM events');

    $cols = [
        ['Backlog', '#6366f1'],
        ['In progress', '#f59e0b'],
        ['Done', '#22c55e'],
    ];
    foreach ($cols as $i => [$title, $color]) {
        $pdo->prepare('INSERT INTO board_columns (title, color, position) VALUES (?, ?, ?)')
            ->execute([$title, $color, $i]);
        $colId = (int) $pdo->lastInsertId();

        $cards = match ($i) {
            0 => [
                ['Design the board schema', 'columns + cards + events tables'],
                ['Build the Rust WS server', 'pure std: SHA-1, base64, RFC6455 frames'],
                ['Wire up SSE transport', 'PHP long-poll over the events table'],
            ],
            1 => [
                ['Drag & drop cards', 'native HTML5 DnD, vanilla JS'],
                ['Live event feed', 'see every mutation in real time'],
            ],
            2 => [
                ['Marry PHP + MariaDB + Rust', 'one board, two transports, zero libraries'],
            ],
        };

        foreach ($cards as $j => [$title2, $note]) {
            $pdo->prepare('INSERT INTO cards (column_id, title, note, position) VALUES (?, ?, ?, ?)')
                ->execute([$colId, $title2, $note, $j]);
        }
    }
}
