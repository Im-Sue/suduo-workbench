-- 多 Agent 协作（ADR-0017，技术设计 2.10、需求 4.3）：委派。发起会话把子任务交给本机另一个 Agent（子会话），
-- 等它完成拿回结果。子会话本身是普通会话（parent_session_id 指向发起会话、relation = delegate）。
CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- 子会话删了委派记录与结果摘要照留（需求 4.9）。
  child_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  agent_id TEXT NOT NULL,
  task TEXT NOT NULL,
  -- agent = 发起会话的 Agent 调用委派工具；user = 用户在输入框 @ Agent。
  origin TEXT NOT NULL CHECK (origin IN ('agent', 'user')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
  auto_handback INTEGER NOT NULL DEFAULT 0 CHECK (auto_handback IN (0, 1)),
  -- 结果已经交给发起会话（等待工具拿到、交回消息发出）。
  delivered INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0, 1)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_delegations_parent ON delegations(parent_session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_delegations_child ON delegations(child_session_id);
