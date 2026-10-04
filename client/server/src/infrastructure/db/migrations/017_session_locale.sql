-- 中英双语（技术设计 §六）：会话创建时的语言。SuDuo 交给 Codex 的说明、工具定义与工具回包按它写，
-- 建线程时定下、之后不随界面设置变（需求 R6）。存量会话都是中文说明建的，默认值正确。
ALTER TABLE sessions ADD COLUMN locale TEXT NOT NULL DEFAULT 'zh-CN';
