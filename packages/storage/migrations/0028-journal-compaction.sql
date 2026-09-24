-- Journal compaction (R-H2) is audited per run. The run-event journal stays append-only:
-- the compaction command lifts its no-update trigger inside its own transaction and restores it
-- byte-identical before committing.
INSERT INTO audit_action_kinds (action, introduced_in_schema) VALUES
  ('storage.journal-compacted', 28);
