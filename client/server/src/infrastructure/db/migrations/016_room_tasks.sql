-- 项目聊天房间与共享 Agent（需求 zjwork-v2-rooms-shared-agent-001，技术设计第六节）。
-- 1) 会话种类：normal = 普通会话；room_task = 房间共享 Agent 在本机执行任务的隐藏会话
--    （普通会话列表不显示，会话页筛选「房间任务」可见、可停止）。
ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal'
  CHECK (kind IN ('normal', 'room_task'));

-- 2) 房间话题 → 本机房间任务会话：一个 (Agent, 房间, 话题根消息) 对应一个会话（一个 Codex 线程）。
--    last_trigger_seq = 上次触发消息的房间序号，续接时只发它之后话题里的新消息；0 = 还没发过。
--    requirement_id / requirement_version：需求房间建会话时的需求与版本（需求只读工具的「当前需求」）。
CREATE TABLE IF NOT EXISTS room_task_sessions (
  agent_id            TEXT NOT NULL,
  room_id             TEXT NOT NULL,
  thread_root_id      TEXT NOT NULL,
  session_id          TEXT NOT NULL UNIQUE,
  remote_project_id   TEXT NOT NULL,
  room_name           TEXT NOT NULL,
  requirement_id      TEXT,
  requirement_version INTEGER CHECK (requirement_version IS NULL OR requirement_version > 0),
  last_trigger_seq    INTEGER NOT NULL DEFAULT 0 CHECK (last_trigger_seq >= 0),
  last_run_id         TEXT,
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (agent_id, room_id, thread_root_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT,
  CHECK (length(agent_id) > 0),
  CHECK (length(room_id) > 0),
  CHECK (length(thread_root_id) > 0),
  CHECK (length(remote_project_id) > 0)
) STRICT;
