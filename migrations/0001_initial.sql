PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 100),
  language TEXT NOT NULL CHECK(language IN ('Bahasa Indonesia','Bahasa Melayu Malaysia','Bahasa Jawa','Bahasa Madura','English (US)')),
  duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 60 AND 1200),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','queued','processing','failed','complete')),
  story_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX projects_owner_updated ON projects(owner, updated_at DESC);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','processing','failed','complete')),
  stage TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  error TEXT,
  render_claimed INTEGER NOT NULL DEFAULT 0,
  request_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX jobs_owner_created ON jobs(owner, created_at DESC);
CREATE INDEX jobs_project_status ON jobs(project_id, status);
CREATE UNIQUE INDEX jobs_owner_request_key ON jobs(owner, request_key) WHERE request_key IS NOT NULL;

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('image','speech','music','video')),
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','generating','ready','failed')),
  object_key TEXT,
  content_type TEXT,
  byte_size INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, kind, ordinal)
);

CREATE INDEX assets_project_job ON assets(project_id, job_id, kind);