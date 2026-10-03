-- 审计记录的需求归属：需求活动时间线按 requirement_id 走索引，
-- 不再靠 before/after JSON 里的 requirementId 扫描。项目级审计为 NULL。
ALTER TABLE audit_logs
  ADD COLUMN requirement_id uuid;

UPDATE audit_logs AS audit
SET requirement_id = audit.resource_id
WHERE audit.resource_type = 'requirement';

UPDATE audit_logs AS audit
SET requirement_id = comment.requirement_id
FROM requirement_comments AS comment
WHERE audit.resource_type = 'comment'
  AND audit.resource_id = comment.id;

UPDATE audit_logs AS audit
SET requirement_id = attachment.requirement_id
FROM attachments AS attachment
WHERE audit.resource_type = 'attachment'
  AND audit.resource_id = attachment.id;

UPDATE audit_logs AS audit
SET requirement_id = artifact_version.requirement_id
FROM requirement_artifact_versions AS artifact_version
WHERE audit.resource_type = 'artifact_version'
  AND audit.resource_id = artifact_version.id;

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_requirement_scope CHECK (
    (resource_type = 'project' AND requirement_id IS NULL)
    OR (resource_type <> 'project' AND requirement_id IS NOT NULL)
  );

CREATE INDEX audit_logs_requirement_created_cursor_idx
  ON audit_logs (requirement_id, created_at DESC, id DESC)
  WHERE requirement_id IS NOT NULL;
