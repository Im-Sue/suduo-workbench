CREATE TABLE requirement_artifact_versions (
  id uuid PRIMARY KEY,
  requirement_id uuid NOT NULL REFERENCES requirements(id) ON DELETE RESTRICT,
  version_number integer NOT NULL,
  published_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  published_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT requirement_artifact_versions_version_positive CHECK (version_number > 0),
  CONSTRAINT requirement_artifact_versions_requirement_version_unique
    UNIQUE (requirement_id, version_number)
);

CREATE TABLE requirement_artifact_version_files (
  id uuid PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES requirement_artifact_versions(id) ON DELETE RESTRICT,
  attachment_id uuid NOT NULL REFERENCES attachments(id) ON DELETE RESTRICT,
  file_name varchar(255) NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 char(64) NOT NULL,
  storage_key varchar(160) NOT NULL,
  CONSTRAINT requirement_artifact_version_files_version_attachment_unique
    UNIQUE (version_id, attachment_id),
  CONSTRAINT requirement_artifact_version_files_file_name_length
    CHECK (char_length(file_name) BETWEEN 1 AND 255),
  CONSTRAINT requirement_artifact_version_files_size_non_negative CHECK (size_bytes >= 0),
  CONSTRAINT requirement_artifact_version_files_sha256_lower_hex
    CHECK (sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX requirement_artifact_versions_requirement_published_idx
  ON requirement_artifact_versions (requirement_id, version_number DESC);

CREATE INDEX requirement_artifact_version_files_storage_key_idx
  ON requirement_artifact_version_files (storage_key);

CREATE TABLE requirement_publish_operations (
  requirement_id uuid NOT NULL REFERENCES requirements(id) ON DELETE RESTRICT,
  operation_key varchar(200) NOT NULL,
  request_digest char(64) NOT NULL,
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (requirement_id, operation_key)
);

ALTER TABLE requirement_comments
  ADD COLUMN artifact_version_id uuid NULL UNIQUE
    REFERENCES requirement_artifact_versions(id) ON DELETE RESTRICT;

ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_resource_type_fixed;

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_resource_type_fixed CHECK (
    resource_type IN ('project', 'requirement', 'comment', 'attachment', 'artifact_version')
  );
