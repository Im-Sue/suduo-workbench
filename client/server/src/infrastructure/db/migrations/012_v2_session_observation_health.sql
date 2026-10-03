ALTER TABLE v2_requirement_session_refs
  ADD COLUMN observation_state TEXT NOT NULL DEFAULT 'unknown'
  CHECK (observation_state IN ('unknown', 'live', 'stale', 'unavailable'));

ALTER TABLE v2_requirement_session_refs
  ADD COLUMN observation_last_success_at INTEGER
  CHECK (observation_last_success_at IS NULL OR observation_last_success_at >= 0);

ALTER TABLE v2_requirement_session_refs
  ADD COLUMN observation_failure_reason TEXT
  CHECK (
    observation_failure_reason IS NULL OR
    observation_failure_reason IN (
      'remote_unavailable',
      'timeline_unavailable',
      'auth_required',
      'protocol_invalid',
      'local_write_failed'
    )
  );
