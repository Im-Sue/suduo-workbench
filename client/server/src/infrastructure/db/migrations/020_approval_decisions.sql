-- 多 Agent（ADR-0014，技术设计 2.3）：ACP Agent 的审批有「始终允许 / 始终拒绝」两种选项，
-- approvals.decision 的 CHECK 放宽为六种；kind 的 CHECK 不变（question / tool 映射到 other）。
-- SQLite 改 CHECK 只能重建表（同 002）。
CREATE TABLE approvals_new (
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
                         CHECK (decision IS NULL OR decision IN (
                           'accept', 'acceptForSession', 'acceptAlways',
                           'decline', 'declineAlways', 'cancel'
                         )),
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

INSERT INTO approvals_new SELECT * FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;

CREATE INDEX IF NOT EXISTS idx_approvals_pending
  ON approvals(status, requested_at)
  WHERE status IN ('pending', 'deciding');

CREATE INDEX IF NOT EXISTS idx_approvals_session_history
  ON approvals(session_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_approvals_thread_history
  ON approvals(session_thread_id, requested_at DESC);
