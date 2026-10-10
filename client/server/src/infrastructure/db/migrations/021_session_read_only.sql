-- 多 Agent（ADR-0014，技术设计 2.4、需求 4.3）：用户可选的「只读」档。
-- approval_mode 的 CHECK 只有 ask / auto / full；sessions 是父表、迁移在事务里开着外键，不能重建表，
-- 所以另加一列：read_only = 1 时会话的审批档是只读，approval_mode 保留切换前的档位。
ALTER TABLE sessions ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0
  CHECK (read_only IN (0, 1));
