-- R-G4 (SEC-01): receipts of the checks the daemon runs for a run, recorded by the daemon as each
-- check finishes. A run prepared with daemon receipt authority freezes its build record from these
-- rows, never from a file its agent can write.
CREATE TABLE run_check_receipts (
 run_id TEXT NOT NULL REFERENCES run_environments(run_id),
 sequence INTEGER NOT NULL CHECK(sequence > 0),
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 PRIMARY KEY(run_id, sequence)
) STRICT;
CREATE TRIGGER run_check_receipt_no_update BEFORE UPDATE ON run_check_receipts BEGIN SELECT RAISE(ABORT,'Check receipts are immutable'); END;
CREATE TRIGGER run_check_receipt_no_delete BEFORE DELETE ON run_check_receipts BEGIN SELECT RAISE(ABORT,'Check receipts are immutable'); END;
