-- 多 Agent 协作（ADR-0017，技术设计 2.11、需求 4.4）：交叉评审。请另一个 Agent 在只读评审会话里评审一个会话的改动，
-- 评审 Agent 用「提交评审意见」工具交回结构化意见。评审会话本身是普通会话（parent_session_id 指向被评会话、relation = review）。
CREATE TABLE IF NOT EXISTS review_reports (
  id TEXT PRIMARY KEY,
  target_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- 评审会话删了报告照留。
  reviewer_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  agent_id TEXT NOT NULL,
  -- agent = 被评会话的 Agent 调用「请求评审」工具；user = 用户在会话头发起。
  origin TEXT NOT NULL CHECK (origin IN ('agent', 'user')),
  focus_json TEXT NOT NULL CHECK (json_valid(focus_json)),
  note TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'submitted', 'unstructured', 'failed', 'cancelled', 'interrupted')),
  findings_json TEXT CHECK (findings_json IS NULL OR json_valid(findings_json)),
  summary TEXT,
  -- 没拿到结构化意见时，评审 Agent 的最终回答（R13）。
  final_message TEXT,
  -- 已经交回原 Agent 修改的意见编号。
  applied_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(applied_json)),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_review_reports_target ON review_reports(target_session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_review_reports_reviewer ON review_reports(reviewer_session_id);
