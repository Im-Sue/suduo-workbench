-- 中英双语（技术设计 §4.3）：共享 Agent 任务的进度与原因存「类型 + 参数」，各人前端按自己的语言渲染；
-- progress / reason 文字列保留，存英文兜底，老客户端照常显示。旧行不回填：没有 code 时前端显示原文。
ALTER TABLE agent_runs
  ADD COLUMN progress_code text NULL,
  ADD COLUMN progress_params jsonb NULL,
  ADD COLUMN reason_code text NULL,
  ADD COLUMN reason_params jsonb NULL;
