ALTER TABLE sessions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'general'
  CHECK (purpose IN ('general', 'pm_requirement', 'backend', 'fe_ui', 'fe_connect', 'test'));

CREATE TABLE IF NOT EXISTS v2_project_workspace_mappings (
  remote_project_id TEXT PRIMARY KEY,
  local_project_id  TEXT NOT NULL UNIQUE,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_validated_at INTEGER NOT NULL,
  FOREIGN KEY (local_project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CHECK (length(remote_project_id) > 0),
  CHECK (length(local_project_id) > 0)
) STRICT;

CREATE TABLE IF NOT EXISTS v2_requirement_session_refs (
  session_id             TEXT PRIMARY KEY,
  remote_project_id      TEXT NOT NULL,
  remote_requirement_id  TEXT NOT NULL,
  requirement_version    INTEGER NOT NULL CHECK (requirement_version > 0),
  material_path          TEXT NOT NULL,
  manifest_sha256        TEXT NOT NULL,
  created_at             INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT,
  CHECK (length(remote_project_id) > 0),
  CHECK (length(remote_requirement_id) > 0),
  CHECK (length(material_path) > 0),
  CHECK (length(manifest_sha256) = 64)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_v2_requirement_session_refs_requirement_version
  ON v2_requirement_session_refs(remote_requirement_id, requirement_version);

CREATE INDEX IF NOT EXISTS idx_v2_requirement_session_refs_project_created
  ON v2_requirement_session_refs(remote_project_id, created_at DESC);
