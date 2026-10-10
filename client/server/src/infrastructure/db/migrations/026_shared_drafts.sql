-- 共享对象草稿（多 Agent 协作 S11，需求 4.7 / 4.13）：交接包、评审报告、会话快照在本机起草、编辑，
-- 本人确认后发布到需求（团队服务器的 requirement_shared_items）。
CREATE TABLE shared_drafts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('handoff', 'review', 'snapshot')),
  -- 起草它的会话（交接包、快照；评审报告是被评会话）。会话删了草稿留着。
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  -- 从哪次评审生成（评审报告）。
  review_id TEXT,
  remote_requirement_id TEXT NOT NULL,
  agent_id TEXT,
  title TEXT NOT NULL,
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'discarded')),
  -- 发布后云端的编号。
  published_item_id TEXT,
  -- 用户在发布对话框里改过（Agent 再交交接包时另起一份，不覆盖用户改过的）。
  user_edited INTEGER NOT NULL DEFAULT 0 CHECK (user_edited IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX shared_drafts_session_idx ON shared_drafts (session_id, created_at);
CREATE INDEX shared_drafts_review_idx ON shared_drafts (review_id) WHERE review_id IS NOT NULL;

-- 协作记录（P2-D1）默认上报到需求，成员可以按会话开关：明确设过的记在这里。没设过的会话跟着发起它的会话
-- （接着做、委派的子会话、评审），一路都没设过就是默认（报）。
CREATE TABLE session_ai_activity_settings (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  reporting INTEGER NOT NULL CHECK (reporting IN (0, 1)),
  updated_at INTEGER NOT NULL
);
