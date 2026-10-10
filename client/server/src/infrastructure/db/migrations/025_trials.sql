-- 多 Agent 协作（ADR-0017，技术设计 2.12、需求 4.5）：并行试做。同一任务交给两三家 Agent，各在独立的 git worktree
-- 与分支里做一版，并排比较后选一版采用（合并或保留分支），其余确认后删除工作目录与分支（R11）。
CREATE TABLE IF NOT EXISTS trial_groups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- 关联的需求（需求会话里发起时）；项目会话发起为 NULL。
  remote_requirement_id TEXT,
  requirement_label TEXT,
  remote_project_id TEXT,
  -- 分支名与提交信息里用的需求编号（REQ-12）；没有编号为 NULL。
  label TEXT,
  -- 发起时的界面语言（重启收尾等后台说明用它）。
  locale TEXT NOT NULL DEFAULT 'zh-CN',
  -- 项目目录在 git 仓库里的相对位置（项目就是仓库根时为空串）：试做会话在 worktree 的同一位置干活。
  project_subdir TEXT NOT NULL DEFAULT '',
  task TEXT NOT NULL,
  -- 各版都基于这次提交（发起时原工作目录的 HEAD）。
  base_commit TEXT NOT NULL,
  base_branch TEXT,
  setup_command TEXT,
  -- active = 进行中 / 待比较；adopted = 已采用一版；closed = 已全部清理。
  status TEXT NOT NULL CHECK (status IN ('active', 'adopted', 'closed')),
  -- 最近一次采用的版本（结果横幅用；各版自己的采用记在 trial_entries）。
  adopted_entry_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trial_entries (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES trial_groups(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  -- 这一版的试做会话；还没建好 / 建失败为 NULL（会话删了也置 NULL，记录照留）。
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  -- preparing = 建工作目录、跑准备命令；setup_failed = 准备失败；started = 会话已开工；failed = 开会话失败；removed = 工作目录已删除。
  status TEXT NOT NULL CHECK (status IN ('preparing', 'setup_failed', 'started', 'failed', 'removed')),
  setup_log TEXT,
  error TEXT,
  -- 分支是这一版建的（`git branch` 成功；没建成的版本清理时不碰同名分支，它可能是别人的）。
  branch_created INTEGER NOT NULL DEFAULT 0 CHECK (branch_created IN (0, 1)),
  -- worktree 建成了。
  worktree_created INTEGER NOT NULL DEFAULT 0 CHECK (worktree_created IN (0, 1)),
  -- `git branch -d` 被拒时 git 的原话（下次清理按没合并处理，确认时照原话标出）。
  branch_error TEXT,
  -- 这一版的采用方式与结果（合并 / 冲突 / git 拒绝 / 保留分支）；没采用为 NULL。
  adopt_mode TEXT CHECK (adopt_mode IS NULL OR adopt_mode IN ('merge', 'keep-branch')),
  adopt_result_json TEXT CHECK (adopt_result_json IS NULL OR json_valid(adopt_result_json)),
  -- 删除时是否连分支一起删了（采用为保留分支的那一版只删工作目录）。
  branch_removed INTEGER NOT NULL DEFAULT 0 CHECK (branch_removed IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trial_groups_project ON trial_groups(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trial_entries_group ON trial_entries(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trial_entries_session ON trial_entries(session_id);
