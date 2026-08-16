-- Realtime Task Board — MariaDB schema
-- (the PHP app also creates everything automatically on first run)

CREATE DATABASE IF NOT EXISTS dockerup_board
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE dockerup_board;

CREATE TABLE IF NOT EXISTS board_columns (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title      VARCHAR(120) NOT NULL,
  color      VARCHAR(7)   NOT NULL DEFAULT '#3b82f6',
  position   INT          NOT NULL DEFAULT 0,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cards (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  column_id  INT UNSIGNED NOT NULL,
  title      VARCHAR(200) NOT NULL,
  note       TEXT         NULL,
  position   INT          NOT NULL DEFAULT 0,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                           ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_cards_column FOREIGN KEY (column_id)
    REFERENCES board_columns (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_attempts (
  bucket       VARCHAR(96) PRIMARY KEY,
  attempts     INT          NOT NULL DEFAULT 0,
  locked_until DATETIME     NULL,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                           ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS events (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  type       VARCHAR(40)  NOT NULL,
  payload    TEXT         NOT NULL,
  client_tx  VARCHAR(40)  NOT NULL DEFAULT '',
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_events_id (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
