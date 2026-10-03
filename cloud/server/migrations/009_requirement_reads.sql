-- 每个人对每条需求的「读到哪儿了」：打开需求详情时更新。
-- 用来算「指派给我的需求有几条新评论」；是个人状态，不参与任何写入校验。
CREATE TABLE requirement_reads (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requirement_id uuid NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, requirement_id)
);
