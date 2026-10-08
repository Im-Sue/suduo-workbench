-- 评论里的文件（需求附件评论文件与优先级 4.2）：只属于评论，不进附件区、不占附件额度。
-- 先上传（comment_id 为空），发评论时在同一事务里挂到评论上，position 记发送时的顺序；之后不能改挂、不能删。
-- 字节放在房间文件同一个存储（room-files 目录，只增不删）：没随评论发出的文件留着，不自动清理（需求 R7）。
CREATE TABLE requirement_comment_files (
  id uuid PRIMARY KEY,
  requirement_id uuid NOT NULL REFERENCES requirements(id) ON DELETE RESTRICT,
  comment_id uuid NULL REFERENCES requirement_comments(id) ON DELETE RESTRICT,
  position integer NULL,
  file_name varchar(255) NOT NULL,
  content_type varchar(255) NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 char(64) NOT NULL,
  storage_key varchar(200) NOT NULL UNIQUE,
  uploaded_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT requirement_comment_files_size_non_negative CHECK (size_bytes >= 0),
  CONSTRAINT requirement_comment_files_sha256_lower_hex CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT requirement_comment_files_sent_pair CHECK ((comment_id IS NULL) = (position IS NULL))
);

CREATE INDEX requirement_comment_files_comment_idx
  ON requirement_comment_files (comment_id, position)
  WHERE comment_id IS NOT NULL;
