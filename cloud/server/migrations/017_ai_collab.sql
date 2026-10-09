-- 多 Agent 协作的团队共享部分（需求「多 Agent 协作机制」4.7 / 4.8 / 4.13，技术设计 2.13）：
-- 需求共享对象（交接包、评审报告、会话快照）、项目 AI 规范（带版本）、协作记录（P2-D1，只含元数据）。

-- 需求共享对象：本人确认内容后发布；项目成员都能撤回（记下是谁），撤回后内容从服务器删掉（content 置空），
-- 标题、大小与读过的记录留着。
CREATE TABLE requirement_shared_items (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  requirement_id uuid NOT NULL REFERENCES requirements(id) ON DELETE RESTRICT,
  kind varchar(16) NOT NULL,
  title varchar(200) NOT NULL,
  content jsonb,
  size_bytes integer NOT NULL,
  -- 来源：哪个 Agent（本机配置表 ID）、哪个本机会话（不透明句柄，只有发布人自己的本机认得）。
  agent_id varchar(32),
  session_ref varchar(128),
  published_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retracted_at timestamptz,
  retracted_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT requirement_shared_items_kind_known CHECK (kind IN ('handoff', 'review', 'snapshot')),
  CONSTRAINT requirement_shared_items_retracted_pair CHECK ((retracted_at IS NULL) = (retracted_by IS NULL)),
  CONSTRAINT requirement_shared_items_size_range CHECK (size_bytes BETWEEN 0 AND 1572864),
  CONSTRAINT requirement_shared_items_agent_format CHECK (agent_id IS NULL OR agent_id ~ '^[a-z][a-z0-9-]{0,31}$'),
  -- 没撤回的必须有内容；撤回后内容删掉。
  CONSTRAINT requirement_shared_items_content_until_retracted CHECK ((retracted_at IS NULL) = (content IS NOT NULL))
);

CREATE INDEX requirement_shared_items_requirement_idx ON requirement_shared_items (requirement_id, published_at DESC, id DESC);

-- 谁读过（发布人以外）：已被读过的内容无法收回，撤回时据此说明。
CREATE TABLE requirement_shared_item_reads (
  item_id uuid NOT NULL REFERENCES requirement_shared_items(id) ON DELETE CASCADE,
  reader_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  first_read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (item_id, reader_id)
);

-- 项目 AI 规范：保存即新版本（后写入的成为新版本，ADR-0004），历史版本都留着。
CREATE TABLE project_ai_rules (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  content text NOT NULL,
  updated_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, version),
  CONSTRAINT project_ai_rules_version_positive CHECK (version >= 1),
  CONSTRAINT project_ai_rules_content_size CHECK (octet_length(content) <= 32768)
);

-- 协作记录（P2-D1）：谁用哪个 Agent 在这条需求上做了什么类型的协作、状态与分支名；不含对话与代码。
-- 同一成员、同一类型、同一本机编号（local_ref）再报时更新状态；按本机发生时间（occurred_at）只认更新的。
-- 类型与状态只查格式：以后加新的不用改迁移。
CREATE TABLE requirement_ai_activity (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  requirement_id uuid NOT NULL REFERENCES requirements(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  local_ref varchar(128) NOT NULL,
  agent_id varchar(32) NOT NULL,
  kind varchar(16) NOT NULL,
  status varchar(16) NOT NULL,
  branch varchar(255),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT requirement_ai_activity_kind_format CHECK (kind ~ '^[a-z][a-z_-]{0,15}$'),
  CONSTRAINT requirement_ai_activity_status_format CHECK (status ~ '^[a-z][a-z_-]{0,15}$'),
  CONSTRAINT requirement_ai_activity_agent_format CHECK (agent_id ~ '^[a-z][a-z0-9-]{0,31}$'),
  CONSTRAINT requirement_ai_activity_local_ref_unique UNIQUE (requirement_id, member_id, kind, local_ref)
);

CREATE INDEX requirement_ai_activity_requirement_idx ON requirement_ai_activity (requirement_id, updated_at DESC, id DESC);

-- 审计：共享对象的发布与撤回属于需求；项目 AI 规范的保存只属于项目。
ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_resource_type_fixed;

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_resource_type_fixed CHECK (
    resource_type IN ('project', 'requirement', 'comment', 'attachment', 'artifact_version', 'room', 'agent_share', 'shared_item', 'ai_rules')
  );

ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_requirement_scope;

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_requirement_scope CHECK (
    (resource_type IN ('project', 'ai_rules') AND requirement_id IS NULL)
    OR resource_type IN ('room', 'agent_share')
    OR (resource_type NOT IN ('project', 'ai_rules', 'room', 'agent_share') AND requirement_id IS NOT NULL)
  );
