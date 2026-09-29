-- R-G5 (SEC-02d): a protected branch (one no managed worktree owns) that moved during a run by
-- something other than the daemon is audited against the run.
INSERT INTO audit_action_kinds (action, introduced_in_schema) VALUES
  ('agent-run.protected-ref-moved', 34);
