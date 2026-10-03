-- 需求会话上下文重做（ADR-0008）：新会话不再生成需求快照，改由会话工具实时取数。
-- 1) material_path / manifest_sha256 改为可空：新会话写 NULL；旧会话保留原值。
-- 2) 新增 context_mode：tools = 挂 zjwork_* 工具的新会话；legacy = 旧版（快照 + 现状文件，已不再刷新）。
--    已有的行一律是 legacy。现状文件相关列保留不用，避免重建时丢旧会话数据。
-- SQLite 改不了列约束，只能重建表；本表没有被其他表引用。
CREATE TABLE v2_requirement_session_refs_015 (
  session_id                  TEXT PRIMARY KEY,
  remote_project_id           TEXT NOT NULL,
  remote_requirement_id       TEXT NOT NULL,
  requirement_version         INTEGER NOT NULL CHECK (requirement_version > 0),
  material_path               TEXT CHECK (material_path IS NULL OR length(material_path) > 0),
  manifest_sha256             TEXT CHECK (manifest_sha256 IS NULL OR length(manifest_sha256) = 64),
  created_at                  INTEGER NOT NULL,
  audit_anchor_created_at     TEXT,
  audit_anchor_id             TEXT CHECK (audit_anchor_id IS NULL OR length(audit_anchor_id) = 36),
  anchor_state                TEXT NOT NULL DEFAULT 'unknown'
    CHECK (anchor_state IN ('known', 'empty', 'unavailable', 'unknown')),
  observation_sha256          TEXT CHECK (observation_sha256 IS NULL OR length(observation_sha256) = 64),
  observation_state           TEXT NOT NULL DEFAULT 'unknown'
    CHECK (observation_state IN ('unknown', 'live', 'stale', 'unavailable')),
  observation_last_success_at INTEGER
    CHECK (observation_last_success_at IS NULL OR observation_last_success_at >= 0),
  observation_failure_reason  TEXT CHECK (
    observation_failure_reason IS NULL OR
    observation_failure_reason IN (
      'remote_unavailable',
      'timeline_unavailable',
      'auth_required',
      'protocol_invalid',
      'local_write_failed'
    )
  ),
  requirement_number          INTEGER CHECK (requirement_number IS NULL OR requirement_number > 0),
  requirement_title           TEXT,
  context_mode                TEXT NOT NULL DEFAULT 'legacy' CHECK (context_mode IN ('legacy', 'tools')),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT,
  CHECK (length(remote_project_id) > 0),
  CHECK (length(remote_requirement_id) > 0)
) STRICT;

INSERT INTO v2_requirement_session_refs_015 (
  session_id, remote_project_id, remote_requirement_id, requirement_version,
  material_path, manifest_sha256, created_at,
  audit_anchor_created_at, audit_anchor_id, anchor_state,
  observation_sha256, observation_state, observation_last_success_at, observation_failure_reason,
  requirement_number, requirement_title, context_mode
)
SELECT
  session_id, remote_project_id, remote_requirement_id, requirement_version,
  material_path, manifest_sha256, created_at,
  audit_anchor_created_at, audit_anchor_id, anchor_state,
  observation_sha256, observation_state, observation_last_success_at, observation_failure_reason,
  requirement_number, requirement_title, 'legacy'
FROM v2_requirement_session_refs;

DROP TABLE v2_requirement_session_refs;

ALTER TABLE v2_requirement_session_refs_015 RENAME TO v2_requirement_session_refs;

CREATE INDEX IF NOT EXISTS idx_v2_requirement_session_refs_requirement_version
  ON v2_requirement_session_refs(remote_requirement_id, requirement_version);

CREATE INDEX IF NOT EXISTS idx_v2_requirement_session_refs_project_created
  ON v2_requirement_session_refs(remote_project_id, created_at DESC);
