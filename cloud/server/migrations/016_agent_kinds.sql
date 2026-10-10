-- 多 Agent（ADR-0014，需求「多 Agent 接入与本机工具服务」4.5）：讨论里可以共享任意一家本机 Agent。
-- agents.kind 原来只许 'codex'；放开为格式检查（小写字母开头，字母、数字、连字符，最长 32），默认值仍是 codex。
-- 同一所有者 + 设备 + kind 唯一（011 已有），一台电脑上的每家 Agent 各是一个可 @ 的 Agent。
ALTER TABLE agents DROP CONSTRAINT agents_kind_fixed;
ALTER TABLE agents ADD CONSTRAINT agents_kind_format CHECK (kind ~ '^[a-z][a-z0-9-]{0,31}$');
