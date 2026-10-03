-- 审计时间取语句执行时刻而不是事务开始时刻：同一事务写入的多条审计（如一次 PATCH
-- 同时改正文与负责人）按写入先后有序，时间线不再因 created_at 相同、只能按随机 id
-- 排序而先后颠倒。只改默认值，不回填既有记录。
ALTER TABLE audit_logs
  ALTER COLUMN created_at SET DEFAULT clock_timestamp();
