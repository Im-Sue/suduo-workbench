-- 跨项目会话列表元数据。
-- 1) 最后一句话预览：入账时维护（EventLedger），列表不扫事件。
--    last_message_seq 记录来源事件序号，只接受更新的事件，乱序补账不会回退预览。
ALTER TABLE sessions ADD COLUMN last_message_role TEXT
  CHECK (last_message_role IS NULL OR last_message_role IN ('user', 'assistant'));

ALTER TABLE sessions ADD COLUMN last_message_text TEXT;

ALTER TABLE sessions ADD COLUMN last_message_seq INTEGER
  CHECK (last_message_seq IS NULL OR last_message_seq > 0);

-- 2) 需求会话创建时的远程需求编号与标题快照；旧数据为 NULL，列表不为此逐条请求远程服务。
ALTER TABLE v2_requirement_session_refs ADD COLUMN requirement_number INTEGER
  CHECK (requirement_number IS NULL OR requirement_number > 0);

ALTER TABLE v2_requirement_session_refs ADD COLUMN requirement_title TEXT;

-- 3) 列表排序键：最后活动时间（无则创建时间）倒序，同刻按 id 升序作游标决胜。
CREATE INDEX IF NOT EXISTS idx_sessions_list_recent
  ON sessions(COALESCE(last_activity_at, created_at) DESC, id ASC);

-- 4) 存量会话的预览一次性从账本推导，规则与运行时（session-preview.ts）一致：
--    用户消息取 message.submitted 里 type=text 且 text 为字符串的段，用空格连接；
--    助手回复取 item.completed 里 agentMessage 的字符串正文；空白（含全角空格、不换行空格）不算一句话。
--    这里只保留原文前 600 字（超出补 … 作为截断标记），空白折叠与 120 字截断在读取时统一处理。
WITH raw_candidates AS (
  SELECT
    e.session_id AS session_id,
    e.seq AS seq,
    'user' AS role,
    (
      -- 嵌套 CASE 保证只对对象元素、且 text 为字符串时才取值，异形旧数据不会让迁移报错。
      SELECT group_concat(
        CASE WHEN part.type = 'object' THEN
          CASE WHEN json_type(part.value, '$.text') = 'text'
            THEN json_extract(part.value, '$.text')
          END
        END,
        ' '
      )
      FROM json_each(e.payload_json, '$.content') AS part
      WHERE (CASE WHEN part.type = 'object' THEN json_extract(part.value, '$.type') END) = 'text'
    ) AS text
  FROM events e
  WHERE e.type = 'message.submitted'
  UNION ALL
  SELECT
    e.session_id,
    e.seq,
    'assistant',
    CASE WHEN json_type(e.payload_json, '$.item.text') = 'text'
      THEN json_extract(e.payload_json, '$.item.text')
    END
  FROM events e
  WHERE e.type = 'item.completed'
    AND json_extract(e.payload_json, '$.item.type') = 'agentMessage'
),
candidates AS (
  SELECT
    session_id,
    seq,
    role,
    CASE WHEN length(text) > 600 THEN substr(text, 1, 600) || '…' ELSE text END AS text
  FROM raw_candidates
  WHERE typeof(text) = 'text'
),
ranked AS (
  SELECT
    session_id,
    seq,
    role,
    text,
    ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY seq DESC) AS position
  FROM candidates
  WHERE trim(
    text,
    ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(12288)
  ) <> ''
)
UPDATE sessions
SET last_message_role = ranked.role,
    last_message_text = ranked.text,
    last_message_seq = ranked.seq
FROM ranked
WHERE ranked.session_id = sessions.id
  AND ranked.position = 1;
