-- 会话级模型与推理强度；NULL = 跟随全局默认（Codex config.toml 的 model / model_reasoning_effort，
-- 未配置时取 model/list 的默认模型与模型自身默认强度）。
-- Codex 0.143 的 ReasoningEffort 是「模型声明的非空字符串」，取值白名单在应用层校验，
-- 这里只约束长度，避免以后 Codex 增档时要重建表放宽 CHECK。
ALTER TABLE sessions ADD COLUMN model TEXT
  CHECK (model IS NULL OR length(model) BETWEEN 1 AND 128);

ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT
  CHECK (reasoning_effort IS NULL OR length(reasoning_effort) BETWEEN 1 AND 32);
