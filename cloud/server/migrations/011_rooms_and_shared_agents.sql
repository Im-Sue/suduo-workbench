-- 项目聊天房间与共享 Agent（需求 zjwork-v2-rooms-shared-agent-001）。
-- 房间、消息、文件、Agent、共享、申请共享、Agent 任务。
-- 唯一约束只用于「合并」（重复请求返回已有那一行），不用于拒绝（ADR-0004）：
--   - 每个项目一个默认房间：惰性创建时 ON CONFLICT DO NOTHING；
--   - 消息按 (房间, 客户端 ID) 合并网络重试；
--   - Agent 按 (所有者, 设备, 类型) 合并重复登记；
--   - 一个 Agent 在一个房间同时只有一条开着的共享：再开 = 改时长；
--   - 同一人对同一 Agent 在同一房间只有一条待处理的申请；
--   - 一条消息对一个 Agent 只有一个任务：重试复用这一行。

CREATE TABLE rooms (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  requirement_id uuid NULL REFERENCES requirements(id) ON DELETE RESTRICT,
  kind varchar(32) NOT NULL,
  -- 项目默认房间不存名字，读的时候用项目名（名称跟随项目）。
  name varchar(120) NULL,
  last_seq bigint NOT NULL DEFAULT 0,
  created_by uuid NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz NULL,
  CONSTRAINT rooms_kind_fixed CHECK (kind IN ('project_default', 'requirement')),
  CONSTRAINT rooms_kind_shape CHECK (
    (kind = 'project_default' AND requirement_id IS NULL AND name IS NULL)
    OR (kind = 'requirement' AND requirement_id IS NOT NULL AND name IS NOT NULL)
  ),
  CONSTRAINT rooms_name_length CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT rooms_last_seq_non_negative CHECK (last_seq >= 0)
);

CREATE UNIQUE INDEX rooms_project_default_idx ON rooms (project_id) WHERE kind = 'project_default';
CREATE INDEX rooms_project_created_idx ON rooms (project_id, created_at);
CREATE INDEX rooms_requirement_idx ON rooms (requirement_id, created_at) WHERE requirement_id IS NOT NULL;

-- 成员只决定未读、提醒与 @ 候选，不做访问控制（房间全员可见可加入）。
-- 项目默认房间的成员是隐式的（全部用户）；这里的行只记已读位置，惰性创建。
CREATE TABLE room_members (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_read_seq bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX room_members_user_idx ON room_members (user_id);

CREATE TABLE room_files (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  file_name varchar(255) NOT NULL,
  content_type varchar(255) NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 char(64) NOT NULL,
  storage_key varchar(200) NOT NULL UNIQUE,
  uploaded_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT room_files_size_non_negative CHECK (size_bytes >= 0)
);

CREATE INDEX room_files_room_idx ON room_files (room_id, created_at);

CREATE TABLE agents (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind varchar(32) NOT NULL DEFAULT 'codex',
  device_key varchar(120) NOT NULL,
  device_name varchar(120) NOT NULL,
  last_seen_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agents_kind_fixed CHECK (kind IN ('codex')),
  CONSTRAINT agents_device_unique UNIQUE (owner_id, device_key, kind)
);

-- 真人在线：本机 ZJWork 心跳里报告「有打开着的页面」。
CREATE TABLE user_presence (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_active_at timestamptz NOT NULL
);

CREATE TABLE room_messages (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  seq bigint NOT NULL,
  client_id varchar(120) NULL,
  author_kind varchar(16) NOT NULL,
  author_id uuid NULL REFERENCES users(id) ON DELETE RESTRICT,
  agent_id uuid NULL REFERENCES agents(id) ON DELETE RESTRICT,
  body text NOT NULL,
  mentions jsonb NOT NULL DEFAULT '[]'::jsonb,
  thread_root_id uuid NULL REFERENCES room_messages(id) ON DELETE RESTRICT,
  reply_count integer NOT NULL DEFAULT 0,
  last_reply_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT room_messages_author_kind_fixed CHECK (author_kind IN ('user', 'agent', 'system')),
  CONSTRAINT room_messages_body_length CHECK (char_length(body) <= 100000),
  -- 真人消息有作者无 Agent；Agent 消息以所有者名义发出（作者 = 所有者）并记 Agent；系统消息两者都可空。
  CONSTRAINT room_messages_author_shape CHECK (
    (author_kind = 'user' AND author_id IS NOT NULL AND agent_id IS NULL)
    OR (author_kind = 'agent' AND author_id IS NOT NULL AND agent_id IS NOT NULL)
    OR author_kind = 'system'
  ),
  CONSTRAINT room_messages_seq_unique UNIQUE (room_id, seq)
);

CREATE UNIQUE INDEX room_messages_client_idx ON room_messages (room_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX room_messages_thread_idx ON room_messages (thread_root_id, seq) WHERE thread_root_id IS NOT NULL;

CREATE TABLE room_message_files (
  message_id uuid NOT NULL REFERENCES room_messages(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES room_files(id) ON DELETE RESTRICT,
  position integer NOT NULL,
  PRIMARY KEY (message_id, file_id)
);

CREATE INDEX room_message_files_file_idx ON room_message_files (file_id);

CREATE TABLE agent_shares (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NULL,
  closed_at timestamptz NULL,
  closed_reason varchar(32) NULL,
  CONSTRAINT agent_shares_closed_reason_fixed CHECK (
    closed_reason IS NULL OR closed_reason IN ('closed', 'expired')
  )
);

CREATE UNIQUE INDEX agent_shares_open_idx ON agent_shares (agent_id, room_id) WHERE closed_at IS NULL;
CREATE INDEX agent_shares_room_idx ON agent_shares (room_id, started_at DESC);
-- 每 30 秒的到期扫描只看开着且有到期时间的共享。
CREATE INDEX agent_shares_open_expiry_idx ON agent_shares (expires_at) WHERE closed_at IS NULL AND expires_at IS NOT NULL;

CREATE TABLE agent_share_requests (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status varchar(16) NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz NULL,
  CONSTRAINT agent_share_requests_status_fixed CHECK (status IN ('pending', 'accepted', 'ignored'))
);

CREATE UNIQUE INDEX agent_share_requests_pending_idx
  ON agent_share_requests (room_id, agent_id, requester_id) WHERE status = 'pending';

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  trigger_message_id uuid NOT NULL REFERENCES room_messages(id) ON DELETE RESTRICT,
  thread_root_id uuid NOT NULL REFERENCES room_messages(id) ON DELETE RESTRICT,
  triggered_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status varchar(16) NOT NULL,
  progress text NULL,
  summary text NULL,
  reply_message_id uuid NULL REFERENCES room_messages(id) ON DELETE RESTRICT,
  reason text NULL,
  stop_requested boolean NOT NULL DEFAULT false,
  -- 执行过程：本机会话这一回合的事件（已截断），运行详情直接渲染。
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 排队顺序：创建或重试的时刻。
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  CONSTRAINT agent_runs_status_fixed CHECK (
    status IN ('queued', 'running', 'completed', 'failed', 'stopped', 'offline')
  ),
  CONSTRAINT agent_runs_trigger_agent_unique UNIQUE (trigger_message_id, agent_id)
);

CREATE INDEX agent_runs_agent_queue_idx ON agent_runs (agent_id, status, queued_at);
CREATE INDEX agent_runs_room_idx ON agent_runs (room_id, created_at);
-- 掉线扫描只看排队中 / 执行中的任务。
CREATE INDEX agent_runs_active_idx ON agent_runs (agent_id) WHERE status IN ('queued', 'running');

-- 审计：房间创建、改名、归档与共享开关写审计；这些记录只属于项目、不属于需求。
ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_resource_type_fixed;

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_resource_type_fixed CHECK (
    resource_type IN ('project', 'requirement', 'comment', 'attachment', 'artifact_version', 'room', 'agent_share')
  );

ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_requirement_scope;

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_requirement_scope CHECK (
    (resource_type = 'project' AND requirement_id IS NULL)
    OR resource_type IN ('room', 'agent_share')
    OR (resource_type NOT IN ('project', 'room', 'agent_share') AND requirement_id IS NOT NULL)
  );
