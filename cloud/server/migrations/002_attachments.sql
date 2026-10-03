CREATE TABLE attachments (
  id uuid PRIMARY KEY,
  requirement_id uuid NOT NULL REFERENCES requirements(id) ON DELETE RESTRICT,
  storage_key varchar(160) NOT NULL UNIQUE,
  file_name varchar(255) NOT NULL,
  content_type varchar(255) NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 char(64) NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT attachments_file_name_length CHECK (char_length(file_name) BETWEEN 1 AND 255),
  CONSTRAINT attachments_content_type_length CHECK (char_length(content_type) BETWEEN 1 AND 255),
  CONSTRAINT attachments_size_non_negative CHECK (size_bytes >= 0),
  CONSTRAINT attachments_sha256_lower_hex CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT attachments_delete_pair CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL)
    OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
  )
);

CREATE INDEX attachments_requirement_created_cursor_idx
  ON attachments (requirement_id, created_at ASC, id ASC)
  WHERE deleted_at IS NULL;

CREATE INDEX attachments_deleted_cleanup_idx
  ON attachments (deleted_at ASC, id ASC)
  WHERE deleted_at IS NOT NULL;
