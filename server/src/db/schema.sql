PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS messages (
  gmail_id      TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL,
  from_addr     TEXT NOT NULL,
  from_name     TEXT,
  from_domain   TEXT,
  subject       TEXT NOT NULL DEFAULT '',
  snippet       TEXT NOT NULL DEFAULT '',
  body_excerpt  TEXT NOT NULL DEFAULT '',
  body_chars    INTEGER NOT NULL DEFAULT 0,
  internal_date INTEGER NOT NULL,
  labels_json   TEXT NOT NULL DEFAULT '[]',
  is_noise      INTEGER NOT NULL DEFAULT 0,
  noise_kind    TEXT,
  analysed_at   TEXT,
  fetched_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(internal_date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_noise ON messages(is_noise);

CREATE TABLE IF NOT EXISTS analyses (
  message_id      TEXT PRIMARY KEY REFERENCES messages(gmail_id) ON DELETE CASCADE,
  thread_id       TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL,
  is_attention    INTEGER NOT NULL,
  priority        TEXT NOT NULL,
  confidence      REAL NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  summary         TEXT NOT NULL DEFAULT '',
  why             TEXT NOT NULL DEFAULT '',
  action          TEXT NOT NULL DEFAULT '',
  deadline_iso    TEXT,
  deadline_raw    TEXT,
  decided_by      TEXT NOT NULL DEFAULT 'rules',
  suppression     TEXT,
  signals_json    TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analyses_attention ON analyses(is_attention);

CREATE TABLE IF NOT EXISTS items (
  id                 TEXT PRIMARY KEY,
  event_key          TEXT NOT NULL UNIQUE,
  thread_id          TEXT,
  source_message_id  TEXT NOT NULL,
  source_thread_id   TEXT,
  category           TEXT NOT NULL,
  priority           TEXT NOT NULL,
  confidence         REAL NOT NULL,
  title              TEXT NOT NULL,
  summary            TEXT NOT NULL DEFAULT '',
  why                TEXT NOT NULL DEFAULT '',
  action             TEXT NOT NULL DEFAULT '',
  deadline_iso       TEXT,
  deadline_raw       TEXT,
  status             TEXT NOT NULL DEFAULT 'open',
  resolved_reason    TEXT,
  decided_by         TEXT NOT NULL DEFAULT 'rules',
  notified_at        TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, priority);
CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at DESC);

CREATE TABLE IF NOT EXISTS item_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id  TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL,
  at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_item_events_item ON item_events(item_id);

CREATE TABLE IF NOT EXISTS tokens (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  access_token  TEXT,
  refresh_token TEXT,
  expiry_ms     INTEGER,
  scope         TEXT,
  account_email TEXT,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  fetched     INTEGER NOT NULL DEFAULT 0,
  analysed    INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  items_open  INTEGER NOT NULL DEFAULT 0,
  ai_calls    INTEGER NOT NULL DEFAULT 0,
  degraded    INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
