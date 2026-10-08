-- 多 Agent 接入与协作（ADR-0014、ADR-0017；技术设计 2.6、6.1）。
-- 1) agent_id：会话用的是哪家 Agent；存量会话都是 Codex。
ALTER TABLE sessions ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'codex';

-- 2) 会话图（P2 用，S1 先建列）：父会话、根会话（NULL = 自己就是根）、与父会话的关系、关系补充信息、
--    实际工作目录（并行试做时为 worktree）、所用项目 AI 规范版本。会话角色沿用 kind 列，新角色在 P2 扩。
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;
ALTER TABLE sessions ADD COLUMN root_session_id TEXT;
ALTER TABLE sessions ADD COLUMN relation TEXT
  CHECK (relation IS NULL OR relation IN ('delegate', 'continue', 'review', 'trial'));
ALTER TABLE sessions ADD COLUMN relation_meta_json TEXT
  CHECK (relation_meta_json IS NULL OR json_valid(relation_meta_json));
ALTER TABLE sessions ADD COLUMN workspace_path TEXT;
ALTER TABLE sessions ADD COLUMN rules_version INTEGER;

CREATE INDEX IF NOT EXISTS sessions_root_session_id ON sessions (root_session_id);
CREATE INDEX IF NOT EXISTS sessions_agent_id ON sessions (agent_id);
