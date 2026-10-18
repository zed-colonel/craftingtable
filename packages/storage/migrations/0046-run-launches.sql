-- R-B7 decision 1 (AGT-12): a launch's durable record before its first file. A launch reserves
-- its run here after its Git preflight, before it makes the run directory, and the reservation
-- names what the launch will make: the run directory and the check-reply directory, with the
-- device of the root each is made in. A launch refused before its run row commits removes what it
-- made, then its reservation; once the run row is written and its directory registered
-- (`run_directories`), the reservation is dropped. A start drops a reservation whose run row
-- exists and removes, with what it made, one whose run row does not (a stop cut its launch short).
--
-- `startup_tasks` holds one-time work for the next start: this migration asks it to remove the run
-- directories that no run row, directory row or reservation owns, which refused launches left
-- before this release (AGT-12's orphans). The start removes the row once the work is done.
--
-- A new table: a release without it never writes or reads it, but the deploy preflight (R-H3)
-- refuses a rollback across any migration.

CREATE TABLE run_launches (
  run_id          TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  worktree_id     TEXT NOT NULL REFERENCES worktrees(id) ON DELETE RESTRICT,
  run_directory   TEXT NOT NULL UNIQUE CHECK (length(run_directory) > 1 AND substr(run_directory, 1, 1) = '/'),
  run_device      INTEGER NOT NULL,
  reply_directory TEXT NOT NULL UNIQUE CHECK (length(reply_directory) > 1 AND substr(reply_directory, 1, 1) = '/'),
  reply_device    INTEGER NOT NULL,
  created_at      TEXT NOT NULL
) STRICT;

CREATE TABLE startup_tasks (
  task TEXT PRIMARY KEY CHECK (task IN ('remove-orphan-run-directories'))
) STRICT;

INSERT INTO startup_tasks (task) VALUES ('remove-orphan-run-directories');
