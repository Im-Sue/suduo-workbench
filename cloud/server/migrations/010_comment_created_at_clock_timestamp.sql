-- 评论时间取语句执行时刻而不是事务开始时刻（同 008 对审计表的做法）：
-- 发布确认版等较长的事务里写入的说明评论，created_at 不再早于事务里拿锁等待的那段时间，
-- 「新评论」按已读位置比较时不易漏算。只改默认值，不回填既有记录。
ALTER TABLE requirement_comments
  ALTER COLUMN created_at SET DEFAULT clock_timestamp();
