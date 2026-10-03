ALTER TABLE v2_requirement_session_refs
  ADD COLUMN audit_anchor_created_at TEXT;

ALTER TABLE v2_requirement_session_refs
  ADD COLUMN audit_anchor_id TEXT
  CHECK (audit_anchor_id IS NULL OR length(audit_anchor_id) = 36);

ALTER TABLE v2_requirement_session_refs
  ADD COLUMN anchor_state TEXT NOT NULL DEFAULT 'unknown'
  CHECK (anchor_state IN ('known', 'empty', 'unavailable', 'unknown'));

ALTER TABLE v2_requirement_session_refs
  ADD COLUMN observation_sha256 TEXT
  CHECK (observation_sha256 IS NULL OR length(observation_sha256) = 64);
