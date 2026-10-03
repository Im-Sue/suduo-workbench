ALTER TABLE audit_logs
  ADD COLUMN project_id uuid;

UPDATE audit_logs AS audit
SET project_id = audit.resource_id
WHERE audit.resource_type = 'project';

UPDATE audit_logs AS audit
SET project_id = requirement.project_id
FROM requirements AS requirement
WHERE audit.resource_type = 'requirement'
  AND audit.resource_id = requirement.id;

UPDATE audit_logs AS audit
SET project_id = requirement.project_id
FROM requirement_comments AS comment
JOIN requirements AS requirement ON requirement.id = comment.requirement_id
WHERE audit.resource_type = 'comment'
  AND audit.resource_id = comment.id;

UPDATE audit_logs AS audit
SET project_id = requirement.project_id
FROM attachments AS attachment
JOIN requirements AS requirement ON requirement.id = attachment.requirement_id
WHERE audit.resource_type = 'attachment'
  AND audit.resource_id = attachment.id;

UPDATE audit_logs AS audit
SET project_id = requirement.project_id
FROM requirement_artifact_versions AS artifact_version
JOIN requirements AS requirement ON requirement.id = artifact_version.requirement_id
WHERE audit.resource_type = 'artifact_version'
  AND audit.resource_id = artifact_version.id;

CREATE INDEX audit_logs_project_created_cursor_idx
  ON audit_logs (project_id, created_at DESC, id DESC);

ALTER TABLE audit_logs
  ALTER COLUMN project_id SET NOT NULL;
