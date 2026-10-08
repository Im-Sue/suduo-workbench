-- 需求优先级（需求附件评论文件与优先级 4.3）：0 无、1 低、2 中、3 高、4 紧急。
-- 数值越急越大，按优先级排序时三个键（priority, updated_at, id）都是降序，可以用一条行值比较翻页。
-- 优先级是元数据，改它不递增正文版本（同负责人）。
ALTER TABLE requirements
  ADD COLUMN priority smallint NOT NULL DEFAULT 0,
  ADD CONSTRAINT requirements_priority_range CHECK (priority BETWEEN 0 AND 4);

-- 看板与列表按状态分列取数，主要走第一条；不带状态时走第二条。
CREATE INDEX requirements_project_status_priority_cursor_idx
  ON requirements (project_id, status, priority DESC, updated_at DESC, id DESC);

CREATE INDEX requirements_project_priority_cursor_idx
  ON requirements (project_id, priority DESC, updated_at DESC, id DESC);
