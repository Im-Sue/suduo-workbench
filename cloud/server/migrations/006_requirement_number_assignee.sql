-- 需求编号：项目内按 created_at, id 顺序回填 1..N，之后由 projects.next_requirement_number
-- 在创建事务里原子取号。唯一索引是数据完整性约束，不是并发守卫：取号本身不会冲突。
ALTER TABLE requirements
  ADD COLUMN number integer;

WITH numbered AS (
  SELECT
    id,
    row_number() OVER (PARTITION BY project_id ORDER BY created_at ASC, id ASC) AS number
  FROM requirements
)
UPDATE requirements AS requirement
SET number = numbered.number
FROM numbered
WHERE numbered.id = requirement.id;

ALTER TABLE requirements
  ALTER COLUMN number SET NOT NULL;

ALTER TABLE requirements
  ADD CONSTRAINT requirements_number_positive CHECK (number > 0);

CREATE UNIQUE INDEX requirements_project_number_unique
  ON requirements (project_id, number);

ALTER TABLE projects
  ADD COLUMN next_requirement_number integer NOT NULL DEFAULT 1;

UPDATE projects AS project
SET next_requirement_number = numbered.max_number + 1
FROM (
  SELECT project_id, max(number) AS max_number
  FROM requirements
  GROUP BY project_id
) AS numbered
WHERE numbered.project_id = project.id;

ALTER TABLE projects
  ADD CONSTRAINT projects_next_requirement_number_positive
    CHECK (next_requirement_number > 0);

-- 负责人：单人、可空。
ALTER TABLE requirements
  ADD COLUMN assignee_id uuid NULL REFERENCES users(id) ON DELETE RESTRICT;

CREATE INDEX requirements_project_assignee_idx
  ON requirements (project_id, assignee_id);

-- 描述允许为空字符串。
ALTER TABLE requirements
  DROP CONSTRAINT requirements_summary_length;

ALTER TABLE requirements
  ADD CONSTRAINT requirements_summary_length CHECK (char_length(summary) <= 4000);
