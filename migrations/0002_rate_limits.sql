CREATE TABLE rate_limits (
  owner TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(owner, bucket)
);