PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version       INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  applied_at    INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  root_path      TEXT NOT NULL,
  root_path_key  TEXT NOT NULL UNIQUE,
  state          TEXT NOT NULL DEFAULT 'active'
                 CHECK (state IN ('active', 'removed')),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  last_opened_at INTEGER,
  removed_at     INTEGER,
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (length(id) > 0),
  CHECK (length(name) > 0),
  CHECK (length(root_path) > 0),
  CHECK (
    (state = 'removed' AND removed_at IS NOT NULL)
    OR
    (state = 'active' AND removed_at IS NULL)
  )
) STRICT;

CREATE INDEX IF NOT EXISTS idx_projects_state_recent
  ON projects(state, last_opened_at DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  title            TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'starting'
                   CHECK (state IN ('starting', 'active', 'error', 'archived', 'deleted')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_opened_at   INTEGER,
  last_activity_at INTEGER,
  archived_at      INTEGER,
  deleted_at       INTEGER,
  error_json       TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  version          INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CHECK (length(id) > 0),
  CHECK (length(title) > 0),
  CHECK (state <> 'archived' OR archived_at IS NOT NULL),
  CHECK (state <> 'deleted' OR deleted_at IS NOT NULL)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_sessions_project_state_recent
  ON sessions(project_id, state, last_activity_at DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS session_threads (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  runtime_id     TEXT NOT NULL,
  runtime_kind   TEXT NOT NULL,
  thread_id      TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'primary',
  ordinal        INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  is_primary     INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  state          TEXT NOT NULL DEFAULT 'attached'
                 CHECK (state IN ('attached', 'detached', 'error')),
  metadata_json  TEXT NOT NULL DEFAULT '{}'
                 CHECK (json_valid(metadata_json)),
  attached_at    INTEGER NOT NULL,
  last_seen_at   INTEGER,
  detached_at    INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT,
  UNIQUE (runtime_id, thread_id),
  UNIQUE (session_id, runtime_id, thread_id),
  UNIQUE (session_id, ordinal),
  CHECK (length(runtime_id) > 0),
  CHECK (length(runtime_kind) > 0),
  CHECK (length(thread_id) > 0),
  CHECK (state <> 'detached' OR detached_at IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_session_threads_active_primary
  ON session_threads(session_id)
  WHERE is_primary = 1 AND state = 'attached';

CREATE INDEX IF NOT EXISTS idx_session_threads_session_state
  ON session_threads(session_id, state, ordinal);

CREATE TABLE IF NOT EXISTS events (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id           TEXT NOT NULL UNIQUE,
  session_id         TEXT NOT NULL,
  session_thread_id  TEXT,
  source             TEXT NOT NULL,
  type               TEXT NOT NULL,
  payload_json       TEXT NOT NULL CHECK (json_valid(payload_json)),
  thread_ref_json    TEXT CHECK (thread_ref_json IS NULL OR json_valid(thread_ref_json)),
  turn_ref           TEXT,
  ts                 INTEGER NOT NULL,
  dedupe_key         TEXT,
  created_at         INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY (session_thread_id) REFERENCES session_threads(id) ON DELETE RESTRICT,
  CHECK (length(event_id) > 0),
  CHECK (length(source) > 0),
  CHECK (length(type) > 0),
  CHECK (dedupe_key IS NULL OR length(dedupe_key) > 0)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_events_source_dedupe
  ON events(source, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_session_after
  ON events(session_id, seq);

CREATE INDEX IF NOT EXISTS idx_events_thread_after
  ON events(session_thread_id, seq)
  WHERE session_thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_session_type_after
  ON events(session_id, type, seq);

CREATE TABLE IF NOT EXISTS approvals (
  id                     TEXT PRIMARY KEY,
  session_id             TEXT NOT NULL,
  session_thread_id      TEXT NOT NULL,
  source                 TEXT NOT NULL,
  kind                   TEXT NOT NULL
                         CHECK (kind IN ('command', 'file-change', 'permissions', 'other')),
  status                 TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN (
                           'pending', 'deciding', 'resolved', 'orphaned', 'delivery_failed'
                         )),
  decision               TEXT
                         CHECK (decision IS NULL OR decision IN ('accept', 'decline', 'cancel')),
  runtime_connection_id  TEXT NOT NULL,
  runtime_request_id     TEXT NOT NULL,
  runtime_approval_ref   TEXT NOT NULL,
  dedupe_key             TEXT NOT NULL,
  request_payload_json   TEXT NOT NULL CHECK (json_valid(request_payload_json)),
  decision_payload_json  TEXT CHECK (
                           decision_payload_json IS NULL OR json_valid(decision_payload_json)
                         ),
  request_event_seq      INTEGER NOT NULL,
  decision_event_seq     INTEGER,
  requested_at           INTEGER NOT NULL,
  decided_at             INTEGER,
  decided_by             TEXT,
  error_json             TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  version                INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY (session_thread_id) REFERENCES session_threads(id) ON DELETE RESTRICT,
  FOREIGN KEY (request_event_seq) REFERENCES events(seq) ON DELETE RESTRICT,
  FOREIGN KEY (decision_event_seq) REFERENCES events(seq) ON DELETE RESTRICT,
  UNIQUE (source, dedupe_key),
  CHECK (length(runtime_approval_ref) > 0),
  CHECK (status <> 'resolved' OR (
    decision IS NOT NULL AND decision_event_seq IS NOT NULL AND decided_at IS NOT NULL
  ))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_approvals_pending
  ON approvals(status, requested_at)
  WHERE status IN ('pending', 'deciding');

CREATE INDEX IF NOT EXISTS idx_approvals_session_history
  ON approvals(session_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_approvals_thread_history
  ON approvals(session_thread_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_records (
  scope            TEXT NOT NULL,
  key              TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  status           TEXT NOT NULL
                   CHECK (status IN (
                     'processing', 'completed', 'failed', 'indeterminate'
                   )),
  response_status  INTEGER,
  response_json    TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  resource_type    TEXT,
  resource_id      TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  PRIMARY KEY (scope, key),
  CHECK (length(scope) > 0),
  CHECK (length(key) > 0),
  CHECK (length(request_hash) > 0)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_idempotency_expiry
  ON idempotency_records(expires_at);
