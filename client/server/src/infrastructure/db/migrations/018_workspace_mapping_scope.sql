-- 目录关联按服务器区分、会话记住所属项目（需求 suduo-workspace-mapping-scope-001，技术设计第二节）。

-- 1) 项目会话的所属项目：建会话时写入，之后不随目录关联或服务器变化
--    （与 v2_requirement_session_refs、room_task_sessions 同级；此前靠「目录 → 关联」反查）。
CREATE TABLE IF NOT EXISTS v2_project_session_refs (
  session_id        TEXT PRIMARY KEY,
  remote_project_id TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT,
  CHECK (length(remote_project_id) > 0)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_v2_project_session_refs_remote
  ON v2_project_session_refs (remote_project_id);

-- 存量补记：按当前关联补给普通会话（不是需求会话、也不是房间任务会话），与升级前界面上的归属一致。
INSERT INTO v2_project_session_refs (session_id, remote_project_id, created_at)
SELECT s.id, m.remote_project_id, s.created_at
FROM sessions s
JOIN v2_project_workspace_mappings m ON m.local_project_id = s.project_id
WHERE s.kind = 'normal'
  AND NOT EXISTS (SELECT 1 FROM v2_requirement_session_refs r WHERE r.session_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM room_task_sessions t WHERE t.session_id = s.id);

-- 2) 目录关联重建：加 server_origin（建立关联时连着的服务器），去掉 local_project_id 的唯一约束
--    （一个目录可以关联多个项目，选目录时告知，不再拒绝，见 ADR-0004）。
--    server_origin 为 NULL = 升级前的存量，本机服务启动时记为当前配置的服务器。
CREATE TABLE v2_project_workspace_mappings_next (
  remote_project_id TEXT PRIMARY KEY,
  local_project_id  TEXT NOT NULL,
  server_origin     TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_validated_at INTEGER NOT NULL,
  FOREIGN KEY (local_project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CHECK (length(remote_project_id) > 0),
  CHECK (length(local_project_id) > 0),
  CHECK (server_origin IS NULL OR length(server_origin) > 0)
) STRICT;

INSERT INTO v2_project_workspace_mappings_next
  (remote_project_id, local_project_id, server_origin, created_at, updated_at, last_validated_at)
SELECT remote_project_id, local_project_id, NULL, created_at, updated_at, last_validated_at
FROM v2_project_workspace_mappings;

DROP TABLE v2_project_workspace_mappings;

ALTER TABLE v2_project_workspace_mappings_next RENAME TO v2_project_workspace_mappings;

CREATE INDEX IF NOT EXISTS idx_v2_project_workspace_mappings_local
  ON v2_project_workspace_mappings (server_origin, local_project_id);
