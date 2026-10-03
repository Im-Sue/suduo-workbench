CREATE TABLE users (
  id uuid PRIMARY KEY,
  login_name varchar(64) NOT NULL UNIQUE,
  display_name varchar(80) NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_login_name_length CHECK (char_length(login_name) BETWEEN 3 AND 64),
  CONSTRAINT users_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 80)
);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  name varchar(120) NOT NULL,
  is_archived boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT projects_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT projects_version_positive CHECK (version > 0)
);

CREATE TABLE requirements (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title varchar(200) NOT NULL,
  summary varchar(4000) NOT NULL,
  status varchar(32) NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT requirements_title_length CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT requirements_summary_length CHECK (char_length(summary) BETWEEN 1 AND 4000),
  CONSTRAINT requirements_status_fixed CHECK (
    status IN (
      'draft',
      'ready_for_development',
      'in_development',
      'in_testing',
      'completed',
      'on_hold'
    )
  ),
  CONSTRAINT requirements_version_positive CHECK (version > 0)
);

CREATE TABLE requirement_comments (
  id uuid PRIMARY KEY,
  requirement_id uuid NOT NULL REFERENCES requirements(id) ON DELETE RESTRICT,
  body varchar(4000) NOT NULL,
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT requirement_comments_body_length CHECK (char_length(body) BETWEEN 1 AND 4000)
);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  resource_type varchar(32) NOT NULL,
  resource_id uuid NOT NULL,
  action varchar(64) NOT NULL,
  before_json jsonb,
  after_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_resource_type_fixed CHECK (
    resource_type IN ('project', 'requirement', 'comment', 'attachment')
  )
);

CREATE INDEX projects_updated_cursor_idx
  ON projects (updated_at DESC, id DESC);

CREATE INDEX requirements_project_updated_cursor_idx
  ON requirements (project_id, updated_at DESC, id DESC);

CREATE INDEX requirements_project_status_updated_cursor_idx
  ON requirements (project_id, status, updated_at DESC, id DESC);

CREATE INDEX requirement_comments_requirement_created_cursor_idx
  ON requirement_comments (requirement_id, created_at ASC, id ASC);

CREATE INDEX audit_logs_resource_created_cursor_idx
  ON audit_logs (resource_type, resource_id, created_at DESC, id DESC);

CREATE INDEX audit_logs_created_cursor_idx
  ON audit_logs (created_at DESC, id DESC);
