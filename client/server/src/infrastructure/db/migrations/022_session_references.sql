-- 多 Agent 协作（ADR-0017，技术设计 2.8、需求 4.1 / R8）：跨会话读取的留痕。
-- 引用不建父子关系，只记「谁、什么时候、读了哪个会话的哪一层、读时它到了哪个账本序号」；
-- 再次读取时据此说明「上次读取后又有 N 个新回合」。被读的会话删了也留着（软删除，target 不设外键）。
CREATE TABLE IF NOT EXISTS session_references (
  id TEXT PRIMARY KEY,
  reader_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('session')),
  target_id TEXT NOT NULL,
  view TEXT NOT NULL,
  target_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_references_reader
  ON session_references(reader_session_id, target_id, created_at);

CREATE INDEX IF NOT EXISTS idx_session_references_target
  ON session_references(target_id, created_at);

-- 接着做 / 委派：按父会话查子会话（会话详情的「已由谁接着做」）。
CREATE INDEX IF NOT EXISTS sessions_parent_session_id ON sessions (parent_session_id);
